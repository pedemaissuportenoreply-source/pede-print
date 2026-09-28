; Desinstalação: remove a entrada de inicialização criada por
; app.setLoginItemSettings (HKCU\...\Run). Sem isto o Windows continuaria
; tentando abrir um executável que não existe mais a cada login.
; No auto-update o instalador novo roda o desinstalador antigo com --updated:
; aí a chave Run FICA (${isUpdated}), senão o agente para de subir com o Windows.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Pede+ Print"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "pede-print"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  ${endIf}
!macroend
