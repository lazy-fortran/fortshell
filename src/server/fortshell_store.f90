module fortshell_store
    !! Documents as append-only operation logs under one data directory. A
    !! client sends numbered batches; a batch is acknowledged only after it is
    !! on disk, and a repeated batch is acknowledged again without being
    !! stored twice, so a client may resend until it sees the acknowledgement.
    use, intrinsic :: iso_c_binding
    use, intrinsic :: iso_fortran_env, only: int64
    implicit none
    private

    public :: store_append, store_changes_dir, store_init, store_list, store_read, &
        store_size, valid_id

    integer, parameter, public :: STORE_OK = 0, STORE_GAP = 1, STORE_IO = 2

    integer(c_int), parameter :: LOCK_EX = 2

    ! struct dirent of glibc on 64-bit Linux.
    type, bind(C) :: dirent_t
        integer(c_int64_t) :: ino, off
        integer(c_short) :: reclen
        character(kind=c_char) :: kind
        character(kind=c_char) :: name(256)
    end type dirent_t

    interface
        function c_creat(path, mode) bind(C, name='creat') result(fd)
            import :: c_char, c_int
            character(kind=c_char), intent(in) :: path(*)
            integer(c_int), value :: mode
            integer(c_int) :: fd
        end function c_creat

        function c_flock(fd, op) bind(C, name='flock') result(rc)
            import :: c_int
            integer(c_int), value :: fd, op
            integer(c_int) :: rc
        end function c_flock

        function c_fsync(fd) bind(C, name='fsync') result(rc)
            import :: c_int
            integer(c_int), value :: fd
            integer(c_int) :: rc
        end function c_fsync

        function c_close(fd) bind(C, name='close') result(rc)
            import :: c_int
            integer(c_int), value :: fd
            integer(c_int) :: rc
        end function c_close

        function c_opendir(path) bind(C, name='opendir') result(dir)
            import :: c_char, c_ptr
            character(kind=c_char), intent(in) :: path(*)
            type(c_ptr) :: dir
        end function c_opendir

        function c_readdir(dir) bind(C, name='readdir') result(entry)
            import :: c_ptr
            type(c_ptr), value :: dir
            type(c_ptr) :: entry
        end function c_readdir

        function c_closedir(dir) bind(C, name='closedir') result(rc)
            import :: c_ptr, c_int
            type(c_ptr), value :: dir
            integer(c_int) :: rc
        end function c_closedir

        function c_rename(from, to) bind(C, name='rename') result(rc)
            import :: c_char, c_int
            character(kind=c_char), intent(in) :: from(*), to(*)
            integer(c_int) :: rc
        end function c_rename

        function c_mkdir(path, mode) bind(C, name='mkdir') result(rc)
            import :: c_char, c_int
            character(kind=c_char), intent(in) :: path(*)
            integer(c_int), value :: mode
            integer(c_int) :: rc
        end function c_mkdir
    end interface

contains

    pure logical function valid_id(id)
        !! Document and client ids: 1 to 64 of a-z, 0-9 and '-'.
        character(len=*), intent(in) :: id

        valid_id = len(id) >= 1 .and. len(id) <= 64 .and. &
            verify(id, 'abcdefghijklmnopqrstuvwxyz0123456789-') == 0
    end function valid_id

    subroutine store_init(data, stat)
        character(len=*), intent(in) :: data
        integer, intent(out) :: stat

        call make_dir(data, stat)
        if (stat == 0) call make_dir(data//'/docs', stat)
        if (stat == 0) call make_dir(store_changes_dir(data), stat)
        if (stat == 0) call make_dir(data//'/sessions', stat)
    end subroutine store_init

    function store_changes_dir(data) result(dir)
        !! One file per document is rewritten here after each append, so an
        !! event stream can follow all documents through one directory watch.
        character(len=*), intent(in) :: data
        character(len=:), allocatable :: dir

        dir = data//'/changes'
    end function store_changes_dir

    subroutine store_append(data, doc, client, seq, batch, size, stat)
        !! Appends batch `seq` of `client` to document `doc`. Batches of one
        !! client are numbered from 1 without gaps. `size` is the log size
        !! after the batch. STORE_GAP means an earlier batch is missing.
        character(len=*), intent(in) :: data, doc, client, batch
        integer, intent(in) :: seq
        integer(int64), intent(out) :: size
        integer, intent(out) :: stat
        character(len=:), allocatable :: dir, record
        integer(c_int) :: lock, rc
        integer :: last, unit, ios
        character(len=24) :: head

        size = -1
        stat = STORE_IO
        dir = data//'/docs/'//doc
        call make_dir(dir, ios)
        if (ios /= 0) return
        lock = c_creat(dir//'/lock'//c_null_char, int(o'600', c_int))
        if (lock < 0) return
        if (c_flock(lock, LOCK_EX) /= 0) then
            rc = c_close(lock)
            return
        end if
        last = last_seq(dir, client)
        if (seq <= last) then
            size = store_size(data, doc)
            stat = STORE_OK
        else if (seq > last + 1) then
            size = store_size(data, doc)
            stat = STORE_GAP
        else
            write (head, '(i0)') len(batch)
            record = client//' '//trim(itoa(seq))//' '//trim(head)//achar(10)//batch//achar(10)
            open (newunit=unit, file=dir//'/log', access='stream', form='unformatted', &
                position='append', status='unknown', action='write', iostat=ios)
            if (ios == 0) write (unit, iostat=ios) record
            if (ios == 0) flush (unit, iostat=ios)
            if (ios == 0) then
                ! gfortran's fnum gives the descriptor; the server is built with gfortran.
                if (c_fsync(int(fnum(unit), c_int)) /= 0) ios = 1
            end if
            if (ios == 0) close (unit, iostat=ios)
            if (ios == 0) call write_text(dir//'/client-'//client, itoa(seq), ios)
            if (ios == 0) then
                size = store_size(data, doc)
                call write_text(store_changes_dir(data)//'/'//doc, itoa64(size), ios)
                stat = STORE_OK
            end if
        end if
        rc = c_close(lock)
    end subroutine store_append

    function store_size(data, doc) result(size)
        character(len=*), intent(in) :: data, doc
        integer(int64) :: size
        logical :: exists

        inquire (file=data//'/docs/'//doc//'/log', exist=exists, size=size)
        if (.not. exists) size = 0
    end function store_size

    subroutine store_read(data, doc, from, bytes, stat)
        !! The log of `doc` from byte offset `from` (0-based) to its end.
        character(len=*), intent(in) :: data, doc
        integer(int64), intent(in) :: from
        character(len=:), allocatable, intent(out) :: bytes
        integer, intent(out) :: stat
        integer(int64) :: size
        integer :: unit

        bytes = ''
        size = store_size(data, doc)
        stat = 0
        if (from < 0 .or. from > size) then
            stat = 1
            return
        end if
        if (size == from) return
        open (newunit=unit, file=data//'/docs/'//doc//'/log', access='stream', &
            form='unformatted', status='old', action='read', iostat=stat)
        if (stat /= 0) return
        bytes = repeat(' ', int(size - from))
        read (unit, pos=from + 1, iostat=stat) bytes
        close (unit)
    end subroutine store_read

    function store_list(data) result(json)
        !! {"docs":{"id":size,...}} from the change files, one per document.
        character(len=*), intent(in) :: data
        character(len=:), allocatable :: json, name
        type(c_ptr) :: dir, entry
        type(dirent_t), pointer :: d
        integer(c_int) :: rc
        integer :: n, k

        json = '{"docs":{'
        n = 0
        dir = c_opendir(store_changes_dir(data)//c_null_char)
        if (c_associated(dir)) then
            do
                entry = c_readdir(dir)
                if (.not. c_associated(entry)) exit
                call c_f_pointer(entry, d)
                k = 0
                do while (k < size(d%name))
                    if (d%name(k + 1) == c_null_char) exit
                    k = k + 1
                end do
                name = transfer(d%name(1:k), repeat(' ', k))
                if (.not. valid_id(name)) cycle
                if (n > 0) json = json//','
                json = json//'"'//name//'":'//trim(itoa64(store_size(data, name)))
                n = n + 1
            end do
            rc = c_closedir(dir)
        end if
        json = json//'}}'
    end function store_list

    integer function last_seq(dir, client) result(seq)
        character(len=*), intent(in) :: dir, client
        integer :: unit, ios

        seq = 0
        open (newunit=unit, file=dir//'/client-'//client, status='old', action='read', iostat=ios)
        if (ios /= 0) return
        read (unit, *, iostat=ios) seq
        if (ios /= 0) seq = 0
        close (unit)
    end function last_seq

    subroutine write_text(path, text, stat)
        !! Replaces `path` through a rename, so readers never see half a file.
        character(len=*), intent(in) :: path, text
        integer, intent(out) :: stat
        integer :: unit

        open (newunit=unit, file=path//'.tmp', status='replace', action='write', iostat=stat)
        if (stat /= 0) return
        write (unit, '(a)', iostat=stat) text
        close (unit)
        if (stat == 0) then
            if (c_rename(path//'.tmp'//c_null_char, path//c_null_char) /= 0) stat = 1
        end if
    end subroutine write_text

    subroutine make_dir(path, stat)
        character(len=*), intent(in) :: path
        integer, intent(out) :: stat
        logical :: exists

        stat = 0
        inquire (file=path//'/.', exist=exists)
        if (exists) return
        if (c_mkdir(path//c_null_char, int(o'700', c_int)) /= 0) then
            inquire (file=path//'/.', exist=exists)
            if (.not. exists) stat = 1
        end if
    end subroutine make_dir

    pure function itoa(k) result(s)
        integer, intent(in) :: k
        character(len=:), allocatable :: s
        character(len=12) :: buf

        write (buf, '(i0)') k
        s = trim(buf)
    end function itoa

    pure function itoa64(k) result(s)
        integer(int64), intent(in) :: k
        character(len=:), allocatable :: s
        character(len=24) :: buf

        write (buf, '(i0)') k
        s = trim(buf)
    end function itoa64

end module fortshell_store
