on run argv
  if (count of argv) is not 2 then error "Expected recipient and message"
  set recipientHandle to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to first service whose service type = iMessage
    set targetBuddy to buddy recipientHandle of targetService
    send messageText to targetBuddy
  end tell
  return "sent"
end run
