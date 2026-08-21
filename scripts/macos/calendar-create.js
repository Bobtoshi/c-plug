function run(argv) {
  const payload = JSON.parse(argv[0]);
  const Calendar = Application("Calendar");
  const calendars = Calendar.calendars();
  if (!calendars.length) throw new Error("No Calendar calendars are available.");
  let target = payload.calendar ? calendars.find((item) => item.name() === payload.calendar) : null;
  if (!target) target = calendars.find((item) => {
    try { return item.writable(); } catch (_) { return true; }
  }) || calendars[0];
  const event = Calendar.Event({
    summary: payload.title,
    startDate: new Date(payload.start),
    endDate: new Date(payload.end),
    description: payload.notes || ""
  });
  target.events.push(event);
  return JSON.stringify({ id: event.uid(), calendar: target.name() });
}
