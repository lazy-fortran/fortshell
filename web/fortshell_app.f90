module fortshell_app
    use, intrinsic :: iso_c_binding, only: c_int
    use fortui, only: row_begin, row_end, button, text, ui_str, &
        ui_shortcut, slider, UI_CAPTION
    use fortshell_document
    implicit none
    private
    public :: compose
    interface
        subroutine host_action(action, value) bind(C,name='fortshell_action')
            import c_int
            integer(c_int), value :: action,value
        end subroutine
    end interface
contains
    subroutine compose()
        integer(c_int) :: id, tool
        real :: width
        call row_begin(gap=6.0,look='toolbar')
        call text('FortShell',id='brand',look='brand')
        if (button('previous','Previous')) call change_page(-1)
        call text(ui_str(fs_current())//' / '//ui_str(fs_pages(0)),id='page-count')
        if (button('next','Next +')) call change_page(1)
        if (button('undo','Undo',enabled=fs_can_undo()/=0)) then
            id = fs_undo()
            call host_action(2,id)
        end if
        if (button('redo','Redo',enabled=fs_can_redo()/=0)) then
            id = fs_redo()
            call host_action(2,id)
        end if
        tool = fs_tool(-1)
        if (button('pen',merge('Pen *','Pen  ',tool==0))) tool = fs_tool(0)
        if (button('eraser',merge('Eraser *','Eraser  ',tool==1))) tool = fs_tool(1)
        width = fs_width(0.0)
        if (slider('width',0.15,2.5,width,width=85.0)) width = fs_width(width)
        if (button('import','Open...')) call host_action(3,0)
        if (button('export','PDF')) call host_action(4,0)
        if (button('backup','Notebook')) call host_action(5,0)
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
