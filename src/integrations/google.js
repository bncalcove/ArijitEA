import { google } from 'googleapis';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

let authed;
export function googleAuth() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return null;
  if (!authed) {
    authed = oauthClient();
    authed.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return authed;
}

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN);
