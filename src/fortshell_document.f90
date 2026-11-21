module fortshell_document
    use, intrinsic :: iso_c_binding, only: c_int, c_float, c_double, c_ptr, c_loc, c_null_ptr
    use, intrinsic :: ieee_arithmetic, only: ieee_is_finite
    use fortink, only: ink_state_t, ink_reset, ink_batch
    implicit none
    private
    public :: fs_reset, fs_begin, fs_append, fs_finish, fs_count, fs_current, fs_pages, &
        fs_page, fs_next, fs_previous, fs_visible, fs_toggle, fs_undo, fs_redo, &
        fs_size, fs_data, fs_meta, fs_input, fs_output, fs_width, fs_tool, &
        fs_dimensions, fs_set_dimensions, fs_stroke_page, fs_can_undo, fs_can_redo, fs_colour, &
        fs_group, fs_copy, fs_insert_page, fs_select
    ! Pen colours are indices into the host's palette.
    integer, parameter, public :: FS_COLOURS = 6
    integer, parameter :: BATCH = 2048
    real(c_float), target, save :: input_buffer(4, BATCH), output_buffer(3, BATCH)
    type :: stroke_t
        real(c_float), allocatable :: raw(:, :), modeled(:, :)
        real(c_float) :: width = 0.65
        integer :: n = 0, page = 1, colour = 0, engine = 0
        logical :: visible = .false.
    end type
    type(stroke_t), allocatable, target, save :: strokes(:)
    real(c_float), allocatable, target, save :: dimensions(:, :)
    integer, allocatable, save :: history(:, :)
    integer, save :: stroke_count = 0, current_page = 1, page_count = 1
    integer, save :: history_head = 0, history_count = 0, active = 0
    ! Entries recorded while a group is open share its number and are undone together.
    integer, save :: group = 0, groups = 0
    integer(c_int), save :: tool = 0, pen_colour = 0
    real(c_float), save :: pen_width = 1.5
    type(ink_state_t), save :: ink
    ! Documents not shown keep their state here; fs_select swaps it in.
    type :: document_t
        type(stroke_t), allocatable :: strokes(:)
        real(c_float), allocatable :: dimensions(:, :)
        integer, allocatable :: history(:, :)
        integer :: stroke_count = 0, current_page = 1, page_count = 1
        integer :: history_head = 0, history_count = 0, group = 0, groups = 0
    end type
    type(document_t), allocatable, save :: documents(:)
    integer, save :: selected = 1
contains
    integer(c_int) function fs_select(k) bind(C)
        !! Shows document `k` (1 to 64), a new empty one the first time. Pen
        !! settings stay. The swap moves allocations, so its cost does not
        !! grow with the documents. Returns k, or 0 during a stroke.
        integer(c_int), value :: k
        fs_select = 0
        if (active /= 0 .or. k < 1 .or. k > 64) return
        if (.not. allocated(strokes)) call fs_reset()
        if (.not. allocated(documents)) allocate(documents(64))
        fs_select = k
        if (k == selected) return
        associate(d => documents(selected))
            call move_alloc(strokes, d%strokes)
            call move_alloc(dimensions, d%dimensions)
            call move_alloc(history, d%history)
            d%stroke_count = stroke_count; d%current_page = current_page
            d%page_count = page_count; d%history_head = history_head
            d%history_count = history_count; d%group = group; d%groups = groups
        end associate
        selected = k
        associate(d => documents(k))
            if (.not. allocated(d%strokes)) then
                call fs_reset()
                return
            end if
            call move_alloc(d%strokes, strokes)
            call move_alloc(d%dimensions, dimensions)
            call move_alloc(d%history, history)
            stroke_count = d%stroke_count; current_page = d%current_page
            page_count = d%page_count; history_head = d%history_head
            history_count = d%history_count; group = d%group; groups = d%groups
        end associate
    end function

    subroutine fs_reset() bind(C)
        if (allocated(strokes)) deallocate(strokes)
        if (allocated(history)) deallocate(history)
        if (allocated(dimensions)) deallocate(dimensions)
        allocate(strokes(64), history(3,128), dimensions(2,64))
        dimensions(1,:) = 297
        dimensions(2,:) = 210
        stroke_count = 0
        current_page = 1
        page_count = 1
        history_head = 0
        history_count = 0
        active = 0
        group = 0
        groups = 0
    end subroutine

    integer(c_int) function fs_count() bind(C)
        fs_count = stroke_count
    end function

    integer(c_int) function fs_current() bind(C)
        fs_current = current_page
    end function

    integer(c_int) function fs_pages(n) bind(C)
        integer(c_int), value :: n
        real(c_float), allocatable :: grown(:,:)
        if (.not. allocated(strokes)) call fs_reset()
        if (n > 0 .and. n <= 100000) then
            if (n > size(dimensions,2)) then
                allocate(grown(2,max(n,size(dimensions,2)*2)))
                grown(1,:) = 297
                grown(2,:) = 210
                grown(:,1:size(dimensions,2)) = dimensions
                call move_alloc(grown, dimensions)
            end if
            page_count = n
            current_page = min(current_page,n)
        end if
        fs_pages = page_count
    end function

    subroutine fs_page(n) bind(C)
        integer(c_int), value :: n
        if (active /= 0) return
        current_page = max(1,min(page_count,n))
    end subroutine

    subroutine fs_next() bind(C)
        integer(c_int) :: n
        if (active /= 0) return
        if (current_page == page_count) n = fs_pages(int(page_count+1,c_int))
        current_page = min(page_count,current_page+1)
    end subroutine

    subroutine fs_previous() bind(C)
        if (active /= 0) return
        current_page = max(1,current_page-1)
    end subroutine

    type(c_ptr) function fs_input() bind(C)
        fs_input = c_loc(input_buffer)
    end function

    type(c_ptr) function fs_output() bind(C)
        fs_output = c_loc(output_buffer)
    end function

    integer(c_int) function fs_begin(width, colour, engine) bind(C)
        real(c_float), value :: width
        integer(c_int), value :: colour, engine
        type(stroke_t), allocatable :: grown(:)
        fs_begin = 0
        if (.not. ieee_is_finite(width)) return
        if (width <= 0 .or. width > 100) return
        if (colour < 0 .or. colour >= FS_COLOURS) return
        if (active /= 0) return
        if (.not. allocated(strokes)) call fs_reset()
        if (stroke_count == size(strokes)) then
            allocate(grown(size(strokes)*2))
            grown(1:stroke_count) = strokes
            call move_alloc(grown,strokes)
        end if
        stroke_count = stroke_count+1
        active = stroke_count
        associate(s => strokes(active))
            s%width = width
            s%colour = colour
            s%engine = engine
            s%page = current_page
            s%visible = .true.
            allocate(s%raw(4,128),s%modeled(3,128))
        end associate
        call ink_reset(ink)
        fs_begin = active
    end function

    integer(c_int) function fs_append(n) bind(C)
        integer(c_int), value :: n
        real(c_float), allocatable :: raw(:,:), modeled(:,:)
        integer :: total, cap
        fs_append = 0
        if (active == 0 .or. n < 1 .or. n > BATCH) return
        if (.not. all(ieee_is_finite(input_buffer(:,1:n)))) return
        if (any(input_buffer(4,1:n)<0) .or. any(input_buffer(4,1:n)>1)) return
        if (n > 1) then
            if (any(input_buffer(3,2:n)<input_buffer(3,1:n-1))) return
        end if
        associate(s => strokes(active))
            if (s%n > 0) then
                if (input_buffer(3,1)<s%raw(3,s%n)) return
            end if
            total = s%n+n
            cap = size(s%raw,2)
            if (total > cap) then
                cap = max(total,cap*2)
                allocate(raw(4,cap), modeled(3,cap))
                raw(:,1:s%n) = s%raw(:,1:s%n)
                modeled(:,1:s%n) = s%modeled(:,1:s%n)
                call move_alloc(raw,s%raw)
                call move_alloc(modeled,s%modeled)
            end if
            if (s%engine == 0) then
                call ink_batch(ink,input_buffer(:,1:n),real(s%width,c_double), &
                    output_buffer(:,1:n))
            else
                if (.not. all(ieee_is_finite(output_buffer(:,1:n)))) return
            end if
            ! Allow the lightest modeled pressure while keeping a positive radius.
            output_buffer(3,1:n) = max(output_buffer(3,1:n),s%width*0.09_c_float)
            s%raw(:,s%n+1:total) = input_buffer(:,1:n)
            s%modeled(:,s%n+1:total) = output_buffer(:,1:n)
            s%n = total
            fs_append = total
        end associate
    end function

    subroutine record(id, value)
        integer, intent(in) :: id, value
        integer, allocatable :: grown(:,:)
        if (history_head == size(history,2)) then
            allocate(grown(3,size(history,2)*2))
            grown(:,1:history_head) = history(:,1:history_head)
            call move_alloc(grown,history)
        end if
        history_head = history_head+1
        history_count = history_head
        history(:,history_head) = [id,value,group]
    end subroutine

    subroutine fs_group(open) bind(C)
        !! Opens (1) or closes (0) an undo group: changes recorded in between,
        !! such as clearing a page or moving a selection, are one step.
        integer(c_int), value :: open
        if (open /= 0) then
            groups = groups+1
            group = groups
        else
            group = 0
        end if
    end subroutine

    integer(c_int) function fs_copy(id, dx, dy) bind(C)
        !! A visible copy of stroke `id` moved by (dx, dy) millimetres on the
        !! same page; 0 if `id` is not a stroke.
        integer(c_int), value :: id
        real(c_float), value :: dx, dy
        integer :: page, n
        fs_copy = 0
        if (active /= 0 .or. id < 1 .or. id > stroke_count) return
        if (.not. all(ieee_is_finite([dx,dy]))) return
        page = current_page
        current_page = strokes(id)%page
        fs_copy = fs_begin(strokes(id)%width, int(strokes(id)%colour,c_int), int(strokes(id)%engine,c_int))
        current_page = page
        if (fs_copy == 0) return
        n = strokes(id)%n
        associate(s => strokes(fs_copy), o => strokes(id))
            s%page = o%page
            s%raw = o%raw
            s%modeled = o%modeled
            s%n = n
            s%raw(1,1:n) = s%raw(1,1:n)+dx
            s%raw(2,1:n) = s%raw(2,1:n)+dy
            s%modeled(1,1:n) = s%modeled(1,1:n)+dx
            s%modeled(2,1:n) = s%modeled(2,1:n)+dy
        end associate
        active = 0
        call record(int(fs_copy),1)
    end function

    integer(c_int) function fs_finish(cancel) bind(C)
        integer(c_int), value :: cancel
        fs_finish = active
        if (active == 0) return
        associate(s => strokes(active))
            if (cancel /= 0 .or. s%n == 0) then
                s%visible = .false.
            else
                s%modeled(1:2,s%n) = s%raw(1:2,s%n)
                call record(active,1)
            end if
        end associate
        active = 0
    end function

    integer(c_int) function fs_size(id) bind(C)
        integer(c_int), value :: id
        fs_size = 0
        if (id < 1 .or. id > stroke_count) return
        fs_size = strokes(id)%n
    end function

    type(c_ptr) function fs_data(id, kind) bind(C)
        integer(c_int), value :: id, kind
        fs_data = c_null_ptr
        if (id < 1 .or. id > stroke_count) return
        if (strokes(id)%n == 0) return
        if (kind == 0) then
            fs_data = c_loc(strokes(id)%raw)
        else
            fs_data = c_loc(strokes(id)%modeled)
        end if
    end function

    real(c_float) function fs_meta(id, kind) bind(C)
        integer(c_int), value :: id, kind
        fs_meta = 0
        if (id < 1 .or. id > stroke_count) return
        select case(kind)
        case(0)
            fs_meta = strokes(id)%width
        case(1)
            fs_meta = real(strokes(id)%colour,c_float)
        case(2)
            fs_meta = real(strokes(id)%engine,c_float)
        end select
    end function

    integer(c_int) function fs_stroke_page(id) bind(C)
        integer(c_int), value :: id
        fs_stroke_page = 0
        if (id < 1 .or. id > stroke_count) return
        fs_stroke_page = strokes(id)%page
    end function

    integer(c_int) function fs_visible(id) bind(C)
        integer(c_int), value :: id
        fs_visible = 0
        if (id < 1 .or. id > stroke_count) return
        if (strokes(id)%visible) fs_visible = 1
    end function

    subroutine fs_toggle(id) bind(C)
        integer(c_int), value :: id
        if (active /= 0 .or. id < 1 .or. id > stroke_count) return
        strokes(id)%visible = .not. strokes(id)%visible
        call record(int(id),merge(1,0,strokes(id)%visible))
    end subroutine

    integer(c_int) function fs_undo() bind(C)
        integer :: id
        fs_undo = 0
        if (active /= 0 .or. history_head == 0) return
        do
            id = history(1,history_head)
            strokes(id)%visible = history(2,history_head) == 0
            history_head = history_head-1
            if (history_head == 0) exit
            if (history(3,history_head+1) == 0 .or. &
                history(3,history_head) /= history(3,history_head+1)) exit
        end do
        current_page = strokes(id)%page
        fs_undo = id
    end function

    integer(c_int) function fs_redo() bind(C)
        integer :: id
        fs_redo = 0
        if (active /= 0 .or. history_head == history_count) return
        do
            history_head = history_head+1
            id = history(1,history_head)
            strokes(id)%visible = history(2,history_head) /= 0
            if (history_head == history_count) exit
            if (history(3,history_head) == 0 .or. &
                history(3,history_head) /= history(3,history_head+1)) exit
        end do
        current_page = strokes(id)%page
        fs_redo = id
    end function

    integer(c_int) function fs_can_undo() bind(C)
        fs_can_undo = merge(1,0,history_head>0)
    end function

    integer(c_int) function fs_can_redo() bind(C)
        fs_can_redo = merge(1,0,history_head<history_count)
    end function

    real(c_float) function fs_width(value) bind(C)
        real(c_float), value :: value
        if (ieee_is_finite(value)) then
            if (value > 0 .and. value <= 100) pen_width = value
        end if
        fs_width = pen_width
    end function

    integer(c_int) function fs_tool(value) bind(C)
        integer(c_int), value :: value
        ! 0 pen, 1 eraser, 2 lasso, 3 pointer (clicks instead of writing).
        if (value >= 0 .and. value <= 3) tool = value
        fs_tool = tool
    end function

    integer(c_int) function fs_colour(value) bind(C)
        integer(c_int), value :: value
        if (value >= 0 .and. value < FS_COLOURS) pen_colour = value
        fs_colour = pen_colour
    end function

    real(c_float) function fs_dimensions(page, axis) bind(C)
        integer(c_int), value :: page, axis
        fs_dimensions = 0
        if (page < 1 .or. page > page_count .or. axis < 1 .or. axis > 2) return
        fs_dimensions = dimensions(axis,page)
    end function

    integer(c_int) function fs_insert_page(at) bind(C)
        !! Inserts a blank page of the shown page's size before page `at`
        !! (page_count+1 appends) and shows it. Ink of later pages moves with
        !! its page. Returns the new page, or 0 during a stroke or at the limit.
        integer(c_int), value :: at
        integer(c_int) :: old
        real(c_float) :: size_(2)
        integer :: k
        fs_insert_page = 0
        if (.not. allocated(strokes)) call fs_reset()
        old = page_count
        if (active /= 0 .or. at < 1 .or. at > old + 1) return
        size_ = dimensions(:,current_page)
        if (fs_pages(old + 1) /= old + 1) return
        dimensions(:,at+1:old+1) = dimensions(:,at:old)
        dimensions(:,at) = size_
        do k = 1, stroke_count
            if (strokes(k)%page >= at) strokes(k)%page = strokes(k)%page + 1
        end do
        current_page = at
        fs_insert_page = at
    end function

    subroutine fs_set_dimensions(page, width, height) bind(C)
        integer(c_int), value :: page
        real(c_float), value :: width,height
        if (page < 1 .or. page > page_count) return
        if (.not. all(ieee_is_finite([width,height]))) return
        if (width <= 0 .or. height <= 0 .or. width > 10000 .or. height > 10000) return
        dimensions(:,page) = [width,height]
    end subroutine
end module
