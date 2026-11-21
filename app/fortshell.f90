program fortshell
    !! fortshell init --data DIR
    !! fortshell serve --data DIR --web DIR [--listen HOST:PORT] [--processes N]
    use, intrinsic :: iso_fortran_env, only: error_unit, output_unit
    use fortweb_posix, only: activated_listen_fd, tcp_listen
    use fortweb_server, only: web_serve
    use fortshell_auth, only: auth_init
    use fortshell_server, only: server_configure, server_handle
    use fortshell_store, only: store_init
    implicit none

    character(len=:), allocatable :: command, data, web, listen, token
    integer :: processes, lfd, stat, colon, port, i, n
    character(len=4096) :: arg

    data = ''
    web = ''
    listen = '127.0.0.1:4180'
    processes = 8
    n = command_argument_count()
    if (n < 1) call usage()
    call get_command_argument(1, arg)
    command = trim(arg)
    i = 2
    do while (i <= n)
        call get_command_argument(i, arg)
        if (i == n) call usage()
        select case (trim(arg))
        case ('--data')
            call get_command_argument(i + 1, arg)
            data = trim(arg)
        case ('--web')
            call get_command_argument(i + 1, arg)
            web = trim(arg)
        case ('--listen')
            call get_command_argument(i + 1, arg)
            listen = trim(arg)
        case ('--processes')
            call get_command_argument(i + 1, arg)
            read (arg, *, iostat=stat) processes
            if (stat /= 0 .or. processes < 1) call usage()
        case default
            call usage()
        end select
        i = i + 2
    end do
    if (len(data) == 0) call usage()

    select case (command)
    case ('init')
        call store_init(data, stat)
        if (stat == 0) call auth_init(data, token, stat)
        if (stat /= 0) call fail('cannot initialise '//data)
        write (output_unit, '(a)') token
    case ('serve')
        if (len(web) == 0) call usage()
        call store_init(data, stat)
        if (stat /= 0) call fail('cannot open '//data)
        call server_configure(data, web)
        lfd = activated_listen_fd()
        if (lfd < 0) then
            colon = index(listen, ':', back=.true.)
            if (colon == 0) call usage()
            read (listen(colon + 1:), *, iostat=stat) port
            if (stat /= 0) call usage()
            call tcp_listen(listen(1:colon - 1), port, lfd, stat)
            if (stat /= 0) call fail('cannot listen on '//listen)
        end if
        call web_serve(lfd, server_handle, processes)
    case default
        call usage()
    end select

contains

    subroutine usage()
        write (error_unit, '(a)') 'usage: fortshell init --data DIR', &
            '       fortshell serve --data DIR --web DIR [--listen HOST:PORT] [--processes N]'
        stop 2
    end subroutine usage

    subroutine fail(message)
        character(len=*), intent(in) :: message

        write (error_unit, '(a)') 'fortshell: '//message
        stop 1
    end subroutine fail

end program fortshell
