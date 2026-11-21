program test_server
    !! `fortshell serve` over a real socket: sign-in, idempotent numbered
    !! batches, gaps, log reads, change events and concurrent writers.
    use, intrinsic :: iso_c_binding, only: c_int
    use fortweb_posix, only: sock_bound_port, sock_close, sock_recv, sock_send_all, &
        sock_set_timeouts, tcp_connect, tcp_listen
    use fortweb_proc, only: proc_exit, proc_fork, proc_pid, proc_wait_any
    use fortweb_server, only: web_serve
    use fortshell_auth, only: auth_init
    use fortshell_server, only: server_configure, server_handle
    use fortshell_store, only: store_init
    implicit none

    interface
        function c_setpgid(pid, pgid) bind(C, name='setpgid') result(rc)
            import :: c_int
            integer(c_int), value :: pid, pgid
            integer(c_int) :: rc
        end function c_setpgid

        function c_kill(pid, sig) bind(C, name='kill') result(rc)
            import :: c_int
            integer(c_int), value :: pid, sig
            integer(c_int) :: rc
        end function c_kill
    end interface

    character(len=2), parameter :: CRLF = achar(13)//achar(10)
    character(len=*), parameter :: BYTES = 'Content-Type: application/octet-stream'//CRLF
    character(len=:), allocatable :: root, data, web, token, reply, cookie
    character(len=64) :: name
    integer :: lfd, port, stat, server, unit, k, fd, i, writer, pid, status
    integer(c_int) :: rc

    write (name, '(a,i0)') 'test_server_', proc_pid()
    root = trim(name)
    data = root//'/data'
    web = root//'/web'
    call execute_command_line('mkdir -p '//web)
    open (newunit=unit, file=web//'/index.html', status='replace', action='write')
    write (unit, '(a)') '<title>FortShell</title>'
    close (unit)
    call store_init(data, stat)
    call check(stat == 0, 'data directory created')
    call auth_init(data, token, stat)
    call check(stat == 0 .and. len(token) == 64, 'login token issued')

    call tcp_listen('127.0.0.1', 0, lfd, stat)
    call check(stat == 0, 'listen')
    port = sock_bound_port(lfd)
    server = proc_fork()
    if (server == 0) then
        rc = c_setpgid(0_c_int, 0_c_int)
        call server_configure(data, web)
        call web_serve(lfd, server_handle, 4, timeout=5)
        call proc_exit(0)
    end if
    call sock_close(lfd)

    reply = request('GET / HTTP/1.1'//CRLF//CRLF)
    call check(index(reply, '<title>FortShell</title>') > 0, 'application served without sign-in')

    reply = request('GET /api/docs HTTP/1.1'//CRLF//CRLF)
    call check(status_is(reply, 401), 'documents need a session')

    reply = request('POST /api/login HTTP/1.1'//CRLF//'Content-Type: text/plain'//CRLF// &
        'Content-Length: 64'//CRLF//CRLF//token)
    call check(status_is(reply, 415), 'login needs the binary content type')
    reply = request('POST /api/login HTTP/1.1'//CRLF//BYTES//'Content-Length: 64'//CRLF//CRLF// &
        repeat('0', 64))
    call check(status_is(reply, 403), 'wrong token refused')
    reply = request('POST /api/login HTTP/1.1'//CRLF//BYTES//'Content-Length: 64'//CRLF//CRLF//token)
    call check(status_is(reply, 200), 'right token signs in')
    k = index(reply, 'Set-Cookie: fortshell_session=')
    call check(k > 0, 'session cookie set')
    call check(index(reply, 'HttpOnly; Secure; SameSite=Strict') > 0, 'cookie is HttpOnly, Secure, Strict')
    cookie = 'Cookie: '//reply(k + 12:k + 12 + len('fortshell_session=') + 63)//CRLF

    reply = append('d1', 'c1', 1, 'abc')
    call check(status_is(reply, 200) .and. index(reply, '{"size":') > 0, 'first batch stored')
    reply = append('d1', 'c1', 1, 'abc')
    call check(status_is(reply, 200), 'repeated batch acknowledged')
    reply = append('d1', 'c1', 3, 'xyz')
    call check(status_is(reply, 409) .and. index(reply, '"gap"') > 0, 'gap reported')
    reply = append('d1', 'c1', 2, 'de')
    call check(status_is(reply, 200), 'next batch stored')

    reply = request('GET /api/docs/d1?from=0 HTTP/1.1'//CRLF//cookie//CRLF)
    call check(status_is(reply, 200), 'log read')
    call check(count_of(reply, 'c1 1 3'//achar(10)//'abc'//achar(10)) == 1, 'repeated batch stored once')
    call check(index(reply, 'c1 2 2'//achar(10)//'de'//achar(10)) > 0, 'second batch in order')
    call check(index(reply, 'xyz') == 0, 'batch after a gap not stored')
    call check(index(reply, 'X-Log-Size: 21') > 0, 'log size header')
    reply = request('GET /api/docs/d1?from=11 HTTP/1.1'//CRLF//cookie//CRLF)
    call check(index(reply, CRLF//CRLF//'c1 2 2') > 0, 'read from an offset')
    reply = request('GET /api/docs/d1?from=99 HTTP/1.1'//CRLF//cookie//CRLF)
    call check(status_is(reply, 416), 'offset beyond the log refused')
    reply = request('GET /api/docs/..%2fx HTTP/1.1'//CRLF//cookie//CRLF)
    call check(status_is(reply, 404), 'invalid document id refused')

    reply = request('GET /api/docs HTTP/1.1'//CRLF//cookie//CRLF)
    call check(index(reply, '"d1":21') > 0, 'document listed with its size')

    ! The event stream announces the current state, then each growth.
    call tcp_connect('127.0.0.1', port, fd, stat)
    call sock_set_timeouts(fd, 5)
    call sock_send_all(fd, 'GET /api/events HTTP/1.1'//CRLF//cookie//CRLF, stat)
    reply = read_until(fd, '"size":21}')
    call check(index(reply, 'event: doc') > 0, 'initial event')
    reply = append('d1', 'c2', 1, 'f')
    reply = read_until(fd, '"size":30}')
    call check(index(reply, '"id":"d1","size":30}') > 0, 'event after an append')
    call sock_close(fd)

    ! Writers in parallel processes keep every record whole.
    do writer = 1, 4
        pid = proc_fork()
        if (pid == 0) then
            write (name, '(a,i0)') 'w', writer
            do i = 1, 25
                reply = append('d2', trim(name), i, repeat(achar(96 + writer), 100))
                if (.not. status_is(reply, 200)) call proc_exit(1)
            end do
            call proc_exit(0)
        end if
    end do
    do writer = 1, 4
        call proc_wait_any(pid, status)
        call check(status == 0, 'concurrent writer acknowledged every batch')
    end do
    reply = request('GET /api/docs/d2?from=0 HTTP/1.1'//CRLF//cookie//CRLF)
    do writer = 1, 4
        call check(count_of(reply, repeat(achar(96 + writer), 100)//achar(10)) == 25, &
            'concurrent records intact')
    end do

    reply = request('DELETE /api/session HTTP/1.1'//CRLF//cookie//CRLF)
    call check(index(reply, 'Max-Age=0') > 0, 'sign-out clears the cookie')
    reply = request('GET /api/docs HTTP/1.1'//CRLF//cookie//CRLF)
    call check(status_is(reply, 401), 'session ends with sign-out')

    rc = c_kill(-int(server, c_int), 15_c_int)
    call execute_command_line('rm -rf '//root)

contains

    function append(doc, client, seq, batch) result(reply)
        character(len=*), intent(in) :: doc, client, batch
        integer, intent(in) :: seq
        character(len=:), allocatable :: reply
        character(len=16) :: s, n

        write (s, '(i0)') seq
        write (n, '(i0)') len(batch)
        reply = request('POST /api/docs/'//doc//'?client='//client//'&seq='//trim(s)// &
            ' HTTP/1.1'//CRLF//cookie//BYTES//'Content-Length: '//trim(n)//CRLF//CRLF//batch)
    end function append

    logical function status_is(reply, code)
        character(len=*), intent(in) :: reply
        integer, intent(in) :: code
        character(len=16) :: c

        write (c, '(i0)') code
        status_is = index(reply, 'HTTP/1.1 '//trim(c)//' ') == 1
    end function status_is

    integer function count_of(text, part) result(n)
        character(len=*), intent(in) :: text, part
        integer :: k, at

        n = 0
        at = 1
        do
            k = index(text(at:), part)
            if (k == 0) exit
            n = n + 1
            at = at + k + len(part) - 1
        end do
    end function count_of

    function request(text) result(reply)
        character(len=*), intent(in) :: text
        character(len=:), allocatable :: reply
        character(len=4096) :: buf
        integer :: fd, stat, n

        reply = ''
        call tcp_connect('127.0.0.1', port, fd, stat)
        if (stat /= 0) return
        call sock_set_timeouts(fd, 5)
        call sock_send_all(fd, text, stat)
        do
            n = sock_recv(fd, buf)
            if (n <= 0) exit
            reply = reply//buf(1:n)
        end do
        call sock_close(fd)
    end function request

    function read_until(fd, marker) result(got)
        integer, intent(in) :: fd
        character(len=*), intent(in) :: marker
        character(len=:), allocatable :: got
        character(len=4096) :: buf
        integer :: n

        got = ''
        do while (index(got, marker) == 0)
            n = sock_recv(fd, buf)
            if (n <= 0) exit
            got = got//buf(1:n)
        end do
    end function read_until

    subroutine check(ok, what)
        logical, intent(in) :: ok
        character(len=*), intent(in) :: what

        if (.not. ok) then
            write (*, '(a)') 'FAIL: '//what
            if (allocated(reply)) write (*, '(a)') reply(1:min(len(reply), 600))
            rc = c_kill(-int(server, c_int), 15_c_int)
            error stop 1
        end if
    end subroutine check

end program test_server
