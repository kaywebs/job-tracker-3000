Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
objShell.Run "node server.js", 0, False
WScript.Sleep 1200
objShell.Run "http://localhost:3000"
