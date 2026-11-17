program fortshell
    use fortui, only: ui_init, ui_run
    use fortui_web, only: web_backend_t
    use fortshell_app, only: compose
    use fortshell_document, only: fs_reset
    use fortink_web, only: fi_reset
    implicit none
    integer :: stat
    call fs_reset()
    call fi_reset()
    call ui_init(web_backend_t(root_id='controls'),1200,800,'FortShell',stat=stat)
    if (stat/=0) error stop 'Browser initialization failed'
    call ui_run(compose)
end program
