@echo off
python "%~dp0tools\build.py" || py -3 "%~dp0tools\build.py"
