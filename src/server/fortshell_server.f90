module fortshell_server
    !! Requests of `fortshell serve`: the web application as static files and
    !! the document API below /api, which needs a session.
    use, intrinsic :: iso_fortran_env, only: int64, error_unit
    use fortweb_http, only: http_cookie, http_query_param, http_read_body, &
        http_request_t, http_send_response
    use fortweb_sse, only: sse_begin, sse_follow_dir, sse_send
    use fortweb_static, only: web_send_file
    use fortshell_auth, only: auth_check, auth_login, auth_logout, SESSION_COOKIE
    use fortshell_store, only: STORE_GAP, STORE_OK, store_append, store_changes_dir, &
        store_list, store_read, store_size, valid_id
    implicit none
    private

    public :: server_configure, server_handle

    character(len=:), allocatable :: data_dir, web_dir
    character(len=*), parameter :: JSON = 'application/json', &
        BYTES = 'application/octet-stream'
    character(len=2), parameter :: CRLF = achar(13)//achar(10)

    ! Sizes this event stream has already announced, by document.
    integer, parameter :: MAX_SEEN = 4096
    character(len=64) :: seen_id(MAX_SEEN)
    integer(int64) :: seen_size(MAX_SEEN)
    integer :: n_seen = 0

contains

    subroutine server_configure(data, web)
        character(len=*), intent(in) :: data, web

        data_dir = data
        web_dir = web
    end subroutine server_configure

    subroutine server_handle(fd, req, rest)
        integer, intent(in) :: fd
        type(http_request_t), intent(inout) :: req
        character(len=*), intent(in) :: rest
        character(len=:), allocatable :: session

        if (index(req%path, '/api/') /= 1) then
            call web_send_file(fd, req, web_dir)
            return
        end if
        if (req%path == '/api/login' .and. req%method == 'POST') then
            call login(fd, req, rest)
            return
        end if
        session = http_cookie(req, SESSION_COOKIE)
        if (.not. auth_check(data_dir, session)) then
            call http_send_response(fd, 401, JSON, '{"error":"sign in"}')
            return
        end if
        if (req%path == '/api/session') then
            if (req%method == 'DELETE') then
                call auth_logout(data_dir, session)
                call http_send_response(fd, 200, JSON, '{"signed_in":false}', &
                    'Set-Cookie: '//SESSION_COOKIE//'=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict'//CRLF)
            else
                call http_send_response(fd, 200, JSON, '{"signed_in":true}')
            end if
        else if (req%path == '/api/docs' .and. req%method == 'GET') then
            call http_send_response(fd, 200, JSON, store_list(data_dir))
        else if (req%path == '/api/events' .and. req%method == 'GET') then
            call events(fd)
        else if (index(req%path, '/api/docs/') == 1) then
            call document(fd, req, rest, req%path(len('/api/docs/') + 1:))
        else
            call http_send_response(fd, 404, JSON, '{"error":"not found"}')
        end if
    end subroutine server_handle

    subroutine login(fd, req, rest)
        !! The body is the login token. The required content type cannot be
        !! sent cross-site without a preflight, which this server never grants.
        integer, intent(in) :: fd
        type(http_request_t), intent(inout) :: req
        character(len=*), intent(in) :: rest
        character(len=:), allocatable :: session
        integer :: status
        logical :: ok

        if (.not. bytes_request(req)) then
            call http_send_response(fd, 415, JSON, '{"error":"content type"}')
            return
        end if
        call http_read_body(fd, req, rest, status)
        if (status /= 0) then
            call http_send_response(fd, status, JSON, '{"error":"body"}')
            return
        end if
        call auth_login(data_dir, trim(req%body), session, ok)
        if (.not. ok) then
            call http_send_response(fd, 403, JSON, '{"error":"wrong token"}')
            return
        end if
        call http_send_response(fd, 200, JSON, '{"signed_in":true}', &
            'Set-Cookie: '//SESSION_COOKIE//'='//session// &
            '; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Strict'//CRLF)
    end subroutine login

    subroutine document(fd, req, rest, id)
        !! GET returns the log from byte `from`; POST appends batch `seq` of
        !! `client` and answers with the log size once the batch is on disk.
        integer, intent(in) :: fd
        type(http_request_t), intent(inout) :: req
        character(len=*), intent(in) :: rest, id
        character(len=:), allocatable :: tail, client, text
        integer(int64) :: from, size
        integer :: status, seq, ios

        if (.not. valid_id(id)) then
            call http_send_response(fd, 404, JSON, '{"error":"not found"}')
            return
        end if
        select case (req%method)
        case ('GET')
            text = http_query_param(req%query, 'from')
            read (text, *, iostat=ios) from
            if (ios /= 0) from = 0
            call store_read(data_dir, id, from, tail, status)
            if (status /= 0) then
                call http_send_response(fd, 416, JSON, '{"error":"range"}')
            else
                call http_send_response(fd, 200, BYTES, tail, &
                    'X-Log-Size: '//i64(from + len(tail, int64))//CRLF)
            end if
        case ('POST')
            client = http_query_param(req%query, 'client')
            text = http_query_param(req%query, 'seq')
            read (text, *, iostat=ios) seq
            if (.not. valid_id(client) .or. ios /= 0 .or. seq < 1) then
                call http_send_response(fd, 400, JSON, '{"error":"client and seq"}')
                return
            end if
            if (.not. bytes_request(req)) then
                call http_send_response(fd, 415, JSON, '{"error":"content type"}')
                return
            end if
            call http_read_body(fd, req, rest, status)
            if (status /= 0) then
                call http_send_response(fd, status, JSON, '{"error":"body"}')
                return
            end if
            call store_append(data_dir, id, client, seq, req%body, size, status)
            if (status == STORE_OK) then
                call http_send_response(fd, 200, JSON, '{"size":'//i64(size)//'}')
            else if (status == STORE_GAP) then
                call http_send_response(fd, 409, JSON, '{"error":"gap","size":'//i64(size)//'}')
            else
                write (error_unit, '(a)') 'fortshell: cannot store a batch of '//id
                call http_send_response(fd, 503, JSON, '{"error":"storage"}')
            end if
        case default
            call http_send_response(fd, 405, JSON, '{"error":"method"}')
        end select
    end subroutine document

    subroutine events(fd)
        !! Announces each document whose log grew, as {"id":..,"size":..}.
        integer, intent(in) :: fd
        integer :: stat

        n_seen = 0
        call sse_begin(fd, stat)
        if (stat == 0) call sse_follow_dir(fd, store_changes_dir(data_dir), announce, 15000)
    end subroutine events

    subroutine announce(fd, stat)
        integer, intent(in) :: fd
        integer, intent(out) :: stat
        character(len=:), allocatable :: list, id
        integer :: k, colon, finish, i
        integer(int64) :: now

        stat = 0
        list = store_list(data_dir)
        k = index(list, '{"docs":{') + len('{"docs":{')
        do while (k < len(list) .and. list(k:k) == '"')
            colon = index(list(k:), '":') + k - 1
            id = list(k + 1:colon - 1)
            finish = scan(list(colon + 2:), ',}') + colon + 1
            now = store_size(data_dir, id)
            i = findloc(seen_id(1:n_seen), id, dim=1)
            if (i == 0 .and. n_seen < MAX_SEEN) then
                n_seen = n_seen + 1
                seen_id(n_seen) = id
                seen_size(n_seen) = -1
                i = n_seen
            end if
            if (i == 0) then
                call sse_send(fd, 'doc', '{"id":"'//id//'","size":'//i64(now)//'}', stat)
                if (stat /= 0) return
            else if (seen_size(i) /= now) then
                call sse_send(fd, 'doc', '{"id":"'//id//'","size":'//i64(now)//'}', stat)
                if (stat /= 0) return
                seen_size(i) = now
            end if
            k = finish + 1
        end do
    end subroutine announce

    logical function bytes_request(req)
        type(http_request_t), intent(in) :: req

        bytes_request = .false.
        if (allocated(req%content_type)) bytes_request = req%content_type == BYTES
    end function bytes_request

    pure function i64(k) result(s)
        integer(int64), intent(in) :: k
        character(len=:), allocatable :: s
        character(len=24) :: buf

        write (buf, '(i0)') k
        s = trim(buf)
    end function i64

end module fortshell_server
