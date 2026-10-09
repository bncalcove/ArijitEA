import { google } from 'googleapis';
import { googleAuth } from './google.js';

const calendar = () => google.calendar({ version: 'v3', auth: googleAuth() });

export async function listEvents({ days = 14, pastDays = 2 } = {}) {
  const timeMin = new Date(Date.now() - pastDays * 864e5).toISOString();
  const timeMax = new Date(Date.now() + days * 864e5).toISOString();
  const events = [];
  let pageToken;
  do {
    const res = await calendar().events.list({
      calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
      maxResults: 250, pageToken, showDeleted: true,
    });
    events.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return events.map(normalize).filter(e => e.startAt); // drop all-day-less oddities
}

function detectPlatform(e) {
  const hay = [e.hangoutLink, e.location, e.description, ...(e.conferenceData?.entryPoints || []).map(p => p.uri)]
    .filter(Boolean).join(' ');
  const find = re => (hay.match(re) || [])[0];
  if (e.hangoutLink || /meet\.google\.com/.test(hay)) return { platform: 'meet', link: e.hangoutLink || find(/https:\/\/meet\.google\.com\/[\w-]+/) };
  const zoom = find(/https:\/\/[\w.-]*zoom\.us\/[^\s"<)]+/);
  if (zoom) return { platform: 'zoom', link: zoom };
  const teams = find(/https:\/\/teams\.(microsoft|live)\.com\/[^\s"<)]+/);
  if (teams) return { platform: 'teams', link: teams };
  const video = (e.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video');
  return { platform: 'other', link: video?.uri || null };
}

function normalize(e) {
  const self = (e.attendees || []).find(a => a.self);
  const { platform, link } = detectPlatform(e);
  const allDay = !e.start?.dateTime;
  return {
    id: e.id,
    title: e.summary || '(no title)',
    startAt: e.start?.dateTime ? new Date(e.start.dateTime).toISOString() : null,
    endAt: e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : null,
    allDay,
    cancelled: e.status === 'cancelled' || self?.responseStatus === 'declined',
    platform,
    joinLink: link,
    organizer: e.organizer?.displayName || e.organizer?.email || '',
    organizerSelf: !!e.organizer?.self,
    attendees: (e.attendees || []).filter(a => !a.resource).map(a => ({
      name: a.displayName || a.email, email: (a.email || '').toLowerCase(), response: a.responseStatus, self: !!a.self,
    })),
    rsvpStatus: self?.responseStatus || (e.organizer?.self ? 'accepted' : null),
    description: (e.description || '').slice(0, 2000),
  };
}
