program test_document
    use, intrinsic :: iso_c_binding, only: c_int,c_float,c_ptr,c_f_pointer
    use fortshell_document
    implicit none
    real(c_float), pointer :: input(:,:), data(:,:)
    integer(c_int) :: id,n
    integer :: i,j
    call fs_reset()
    if (fs_current()/=1 .or. fs_pages(0)/=1) error stop 'initial page'
    if (fs_dimensions(1,1)/=297 .or. fs_dimensions(1,2)/=210) error stop 'A4 landscape'
    call fs_next()
    if (fs_pages(0)/=2 .or. fs_current()/=2) error stop 'instant next page'
    call fs_previous()
    id = fs_begin(0.65_c_float,0,0)
    call c_f_pointer(fs_input(),input,[4,2048])
    input(:,1) = [10.,20.,0.,0.5]
    input(:,2) = [11.,21.,0.01,0.5]
    n = fs_append(2)
    if (n/=2) error stop 'append'
    n = fs_finish(0)
    call c_f_pointer(fs_data(id,1),data,[3,2])
    if (any(data(1:2,2)/=[11.,21.])) error stop 'final endpoint'
    if (any(abs(data(3,1:2)-0.19175_c_float)>1e-6_c_float)) error stop 'half-pressure width'
    if (fs_undo()/=id) error stop 'undo id'
    if (fs_visible(id)/=0) error stop 'undo visibility'
    if (fs_redo()/=id) error stop 'redo id'
    if (fs_visible(id)/=1) error stop 'redo visibility'
    call fs_toggle(id)
    if (fs_visible(id)/=0) error stop 'erase'
    n = fs_undo()
    if (fs_visible(id)/=1) error stop 'undo erase'
    n = fs_undo()
    id = fs_begin(0.65_c_float,0,0)
    n = fs_append(1)
    n = fs_finish(0)
    if (fs_redo()/=0) error stop 'branched history'
    id = fs_begin(0.65_c_float,0,0)
    n = fs_append(1)
    n = fs_finish(1)
    if (fs_visible(id)/=0) error stop 'cancel'
    call fs_reset()
    if (fs_count()/=0) error stop 'reset'
    n = fs_pages(200)
    call fs_page(200)
    call fs_next()
    if (fs_pages(0)/=201) error stop 'page growth'
    call fs_reset()
    do i = 1,150
        id = fs_begin(0.65_c_float,0,0)
        do j = 1,500
            input(:,1) = [real(i,c_float),real(j,c_float),real(j,c_float)/240,0.5_c_float]
            n = fs_append(1)
        end do
        n = fs_finish(0)
    end do
    if (fs_count()/=150) error stop 'stroke growth'
    do i = 1,150
        if (fs_size(i)/=500) error stop 'grown stroke samples'
        call c_f_pointer(fs_data(int(i,c_int),0),data,[4,500])
        if (any(data(1,:)/=real(i,c_float))) error stop 'growth preserves earlier strokes'
    end do
    n = fs_pages(100000)
    call fs_page(100000)
    call fs_next()
    if (fs_current()/=fs_pages(0)) error stop 'page limit remains addressable'
end program
