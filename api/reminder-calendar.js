// GPS Leadership — Weekly Check-In Calendar File
// Returns a downloadable .ics file for Apple Calendar and Outlook
// Link included in weekly reminder emails
// URL: /api/reminder-calendar

export default function handler(req, res) {
  // Find the next Monday at 9am ET (14:00 UTC, approximation — close enough for a reminder)
  const now = new Date();
  const nextMonday = new Date(now);
  const day = nextMonday.getUTCDay(); // 0=Sun, 1=Mon
  const daysUntil = day === 1 ? 7 : (8 - day) % 7;
  nextMonday.setUTCDate(nextMonday.getUTCDate() + daysUntil);
  nextMonday.setUTCHours(14, 0, 0, 0); // 9am ET ≈ 14:00 UTC

  const endTime = new Date(nextMonday.getTime() + 15 * 60 * 1000); // 15-min block

  const fmt = (d) => d.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  const uid = `gps-checkin-reminder-${Date.now()}@gpsleadership.org`;
  const now8601 = fmt(now);

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GPS Leadership Solutions//Check-In Reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now8601}`,
    `DTSTART:${fmt(nextMonday)}`,
    `DTEND:${fmt(endTime)}`,
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
    'SUMMARY:GPS Leadership — Weekly Check-In',
    'DESCRIPTION:Complete your weekly GPS Leadership check-in.\\nLog your metric\\, your action for the week\\, and any notes before your next coaching call.',
    'LOCATION:portal.gpsleadership.org',
    'BEGIN:VALARM',
    'TRIGGER:-PT0M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Time to complete your GPS Leadership check-in',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="gps-checkin-reminder.ics"');
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send(ics);
}
