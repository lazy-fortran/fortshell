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
    if (fs_colour(-1)/=0) error stop 'black pen by default'
    if (fs_colour(2)/=2 .or. fs_colour(FS_COLOURS)/=2) error stop 'pen colour selection'
    if (fs_begin(0.65_c_float,FS_COLOURS,0)/=0) error stop 'colour outside the palette'
    id = fs_begin(0.65_c_float,2,0)
    if (nint(fs_meta(id,1))/=2) error stop 'stroke colour'
    n = fs_finish(1)
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
    ! A grouped change (clearing a page, moving a selection) is one undo step.
    call fs_group(1)
    call fs_toggle(1)
    call fs_toggle(2)
    n = fs_copy(3,10.0_c_float,-2.0_c_float)
    call fs_toggle(3)
    call fs_group(0)
    if (n/=151 .or. fs_count()/=151) error stop 'copy id'
    if (fs_visible(1)/=0 .or. fs_visible(2)/=0 .or. fs_visible(3)/=0 .or. fs_visible(n)/=1) &
        error stop 'grouped changes'
    call c_f_pointer(fs_data(n,0),data,[4,500])
    if (any(data(1,:)/=13.0) .or. data(2,1)/=-1.0 .or. fs_size(n)/=500) error stop 'moved copy'
    call c_f_pointer(fs_data(n,1),data,[3,500])
    if (data(1,500)/=13.0) error stop 'moved model'
    call fs_toggle(4)
    i = fs_undo()
    if (fs_visible(4)/=1 .or. fs_visible(1)/=0) error stop 'ungrouped step undone alone'
    i = fs_undo()
    if (fs_visible(1)/=1 .or. fs_visible(2)/=1 .or. fs_visible(3)/=1 .or. fs_visible(n)/=0) &
        error stop 'group undone in one step'
    i = fs_redo()
    if (fs_visible(1)/=0 .or. fs_visible(3)/=0 .or. fs_visible(n)/=1 .or. fs_visible(4)/=1) &
        error stop 'group redone in one step'
    do i = 1,150
        if (fs_size(i)/=500) error stop 'grown stroke samples'
        call c_f_pointer(fs_data(int(i,c_int),0),data,[4,500])
        if (any(data(1,:)/=real(i,c_float))) error stop 'growth preserves earlier strokes'
    end do
    ! A page inserted between others takes the shown page's size and moves later ink.
    call fs_reset()
    n = fs_pages(3)
    call fs_set_dimensions(2,210.0_c_float,297.0_c_float)
    call fs_page(3)
    id = fs_begin(1.0_c_float,0,0)
    n = fs_finish(0)
    call fs_page(2)
    if (fs_insert_page(3)/=3 .or. fs_pages(0)/=4 .or. fs_current()/=3) error stop 'page inserted'
    if (fs_dimensions(3,1)/=210 .or. fs_dimensions(3,2)/=297) error stop 'inserted page takes the shown size'
    if (fs_dimensions(4,1)/=297) error stop 'later page keeps its size'
    if (fs_stroke_page(id)/=4) error stop 'ink of a later page moves with it'
    if (fs_insert_page(6)/=0 .or. fs_insert_page(0)/=0) error stop 'insertion outside the notebook refused'
    if (fs_insert_page(5)/=5 .or. fs_pages(0)/=5) error stop 'insertion at the end appends'
    n = fs_pages(100000)
    if (fs_insert_page(1)/=0) error stop 'no insertion beyond the page limit'
    call fs_page(100000)
    call fs_next()
    if (fs_current()/=fs_pages(0)) error stop 'page limit remains addressable'
end program
