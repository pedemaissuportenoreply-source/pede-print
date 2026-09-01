; Desinstalação: remove a entrada de inicialização criada por
; app.setLoginItemSettings (HKCU\...\Run). Sem isto o Windows continuaria
; tentando abrir um executável que não existe mais a cada login.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pede+ Print"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "pede-print"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
