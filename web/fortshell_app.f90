module fortshell_app
    use, intrinsic :: iso_c_binding, only: c_int
    use fortui, only: row_begin, row_end, button, text, ui_str, &
        ui_shortcut, slider
    use fortshell_document
    implicit none
    private
    public :: compose
    character(len=*), parameter :: COLOUR_NAMES(FS_COLOURS) = [character(len=6) :: &
        'Black', 'Blue', 'Red', 'Green', 'Orange', 'Violet']
    interface
        subroutine host_action(action, value) bind(C,name='fortshell_action')
            import c_int
            integer(c_int), value :: action,value
        end subroutine
    end interface
contains
    subroutine compose()
        integer(c_int) :: id, tool, colour
        integer :: k
        real :: width
        call row_begin(gap=4.0,look='toolbar')

        call row_begin(gap=2.0,look='group')
        if (button('previous','Prev',enabled=fs_current()>1)) call change_page(-1)
        call text(ui_str(fs_current())//' / '//ui_str(fs_pages(0)),id='page-count')
        if (button('next',merge('New ','Next',fs_current()==fs_pages(0)))) call change_page(1)
        call row_end()

        tool = fs_tool(-1)
        call row_begin(gap=2.0,look='group')
        if (button('pen','Pen',pressed=tool==0)) tool = fs_tool(0)
        if (button('eraser','Eraser',pressed=tool==1)) tool = fs_tool(1)
        call row_end()

        colour = fs_colour(-1)
        call row_begin(gap=2.0,look='group')
        do k = 1, FS_COLOURS
            if (button('colour-'//ui_str(k-1),trim(COLOUR_NAMES(k)),look='swatch', &
                pressed=colour==k-1 .and. tool==0)) then
                colour = fs_colour(int(k-1,c_int))
                tool = fs_tool(0)
            end if
        end do
        width = fs_width(0.0)
        if (slider('width',0.15,2.5,width,width=80.0)) width = fs_width(width)
        call row_end()

        call row_begin(gap=2.0,look='group')
        if (button('undo','Undo',enabled=fs_can_undo()/=0)) then
            id = fs_undo()
            call host_action(2,id)
        end if
        if (button('redo','Redo',enabled=fs_can_redo()/=0)) then
            id = fs_redo()
            call host_action(2,id)
        end if
        call row_end()

        call row_begin(gap=2.0,look='group')
        if (button('import','Open')) call host_action(3,0)
        if (button('export','PDF')) call host_action(4,0)
        if (button('backup','Save')) call host_action(5,0)
        call row_end()

        call row_end()
        if (ui_shortcut('ArrowRight')) call change_page(1)
        if (ui_shortcut('ArrowLeft')) call change_page(-1)
        if (ui_shortcut('mod+z')) then
            id = fs_undo()
            call host_action(2,id)
        end if
        if (ui_shortcut('mod+shift+z')) then
            id = fs_redo()
            call host_action(2,id)
        end if
    end subroutine
    subroutine change_page(direction)
        integer,intent(in) :: direction
        if (direction>0) then
            call fs_next()
        else
            call fs_previous()
        end if
        call host_action(1,0)
    end subroutine
end module
