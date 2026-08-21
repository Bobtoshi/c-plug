function run(argv) {
  const days = Math.max(1, Math.min(31, Number(argv[0]) || 7));
  const start = new Date();
  const end = new Date(start.getTime() + days * 86400000);
  const Calendar = Application("Calendar");
  const output = [];
  Calendar.calendars().forEach((calendar) => {
    let events = [];
    try {
      events = calendar.events.whose({ _and: [
        { startDate: { _greaterThanEquals: start } },
        { startDate: { _lessThan: end } }
      ] })();
    } catch (_) { return; }
    events.slice(0, 25).forEach((event) => output.push({
      title: event.summary(),
      start: event.startDate().toISOString(),
      end: event.endDate().toISOString(),
      calendar: calendar.name()
    }));
  });
  output.sort((a, b) => a.start.localeCompare(b.start));
  return JSON.stringify(output.slice(0, 25));
}
