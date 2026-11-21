module fortshell_auth
    !! Sign-in with a login token, then a session cookie. Only SHA-256 hashes
    !! of tokens and sessions are stored, so the data directory alone does not
    !! grant access.
    use fortweb_proc, only: random_hex
    use fx_hash, only: sha256_string
    implicit none
    private

    public :: auth_check, auth_init, auth_login, auth_logout, SESSION_COOKIE

    character(len=*), parameter :: SESSION_COOKIE = 'fortshell_session'

contains

    subroutine auth_init(data, token, stat)
        !! A new login token, replacing any earlier one. Shown once.
        character(len=*), intent(in) :: data
        character(len=:), allocatable, intent(out) :: token
        integer, intent(out) :: stat

        token = random_hex(32, stat)
        if (stat /= 0) return
        call write_line(data//'/login-token.sha256', sha256_string(token), stat)
    end subroutine auth_init

    subroutine auth_login(data, token, session, ok)
        !! A new session for a correct login token.
        character(len=*), intent(in) :: data, token
        character(len=:), allocatable, intent(out) :: session
        logical, intent(out) :: ok
        character(len=64) :: stored
        integer :: unit, stat

        session = ''
        ok = .false.
        if (.not. is_token(token)) return
        open (newunit=unit, file=data//'/login-token.sha256', status='old', action='read', &
            iostat=stat)
        if (stat /= 0) return
        read (unit, '(a)', iostat=stat) stored
        close (unit)
        if (stat /= 0) return
        if (.not. same(sha256_string(token), stored)) return
        session = random_hex(32, stat)
        if (stat /= 0) return
        call write_line(session_file(data, session), 'session', stat)
        ok = stat == 0
    end subroutine auth_login

    logical function auth_check(data, session) result(ok)
        character(len=*), intent(in) :: data, session

        ok = .false.
        if (.not. is_token(session)) return
        inquire (file=session_file(data, session), exist=ok)
    end function auth_check

    subroutine auth_logout(data, session)
        character(len=*), intent(in) :: data, session
        integer :: unit, stat

        if (.not. is_token(session)) return
        open (newunit=unit, file=session_file(data, session), status='old', iostat=stat)
        if (stat == 0) close (unit, status='delete')
    end subroutine auth_logout

    function session_file(data, session) result(path)
        character(len=*), intent(in) :: data, session
        character(len=:), allocatable :: path

        path = data//'/sessions/'//sha256_string(session)
    end function session_file

    pure logical function is_token(s)
        character(len=*), intent(in) :: s

        is_token = len(s) == 64 .and. verify(s, '0123456789abcdef') == 0
    end function is_token

    pure logical function same(a, b)
        !! Compares in time independent of where the strings differ.
        character(len=*), intent(in) :: a, b
        integer :: i, diff

        same = .false.
        if (len(a) /= len(b)) return
        diff = 0
        do i = 1, len(a)
            diff = ior(diff, ieor(iachar(a(i:i)), iachar(b(i:i))))
        end do
        same = diff == 0
    end function same

    subroutine write_line(path, text, stat)
        character(len=*), intent(in) :: path, text
        integer, intent(out) :: stat
        integer :: unit

        open (newunit=unit, file=path, status='replace', action='write', iostat=stat)
        if (stat /= 0) return
        write (unit, '(a)', iostat=stat) text
        close (unit)
    end subroutine write_line

end module fortshell_auth
