import { Linking, PermissionsAndroid, Platform } from 'react-native';
import CallLogs from 'react-native-call-log';
import SmsAndroid from 'react-native-get-sms-android';

export type CallItem = { id: string; number: string; name: string | null; type: string; date: number; duration: number };
export type SmsItem = { id: string; address: string; body: string; date: number; box: 'inbox' | 'sent' };

export async function requestPhonePermissions(): Promise<boolean> {
  const result = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    PermissionsAndroid.PERMISSIONS.READ_SMS,
  ]);
  return Object.values(result).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
}

/**
 * Best-effort prompts that blocking itself doesn't depend on: notifications (Android 13+, for the lock-screen
 * fallback) and "Answer phone calls", which the spam card's button needs in order to hang up.
 */
export async function requestOptionalPermissions() {
  if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ANSWER_PHONE_CALLS);
}

export async function loadCalls(limit = 100): Promise<CallItem[]> {
  const rows = await CallLogs.load(limit);
  return rows.map(r => ({
    id: r.id,
    number: r.phoneNumber,
    name: r.name,
    type: r.type,
    date: Number(r.timestamp),
    duration: r.duration,
  }));
}

function listSms(box: 'inbox' | 'sent', maxCount: number): Promise<SmsItem[]> {
  return new Promise((resolve, reject) => {
    SmsAndroid.list(
      JSON.stringify({ box, maxCount }),
      (err: string) => reject(new Error(String(err))),
      (_count: number, json: string) =>
        resolve(
          (JSON.parse(json) as Array<{ _id: string; address: string; body: string; date: string }>).map(m => ({
            id: `${box}-${m._id}`,
            address: m.address,
            body: m.body,
            date: Number(m.date),
            box,
          })),
        ),
    );
  });
}

export async function loadSms(limit = 100): Promise<SmsItem[]> {
  const [inbox, sent] = await Promise.all([listSms('inbox', limit), listSms('sent', limit)]);
  return [...inbox, ...sent].sort((a, b) => b.date - a.date).slice(0, limit);
}

/**
 * Third-party apps can't read carrier voicemail on Android, so hand off to the phone's voicemail.
 * (The `voicemail:` scheme opens the dialer and calls your voicemail box.)
 */
export function callVoicemail() {
  return Linking.openURL('voicemail:');
}

/** Opens the "Display over other apps" list, where CallGuard must be allowed for the incoming-call card. */
export function openOverlaySettings() {
  return Linking.sendIntent('android.settings.action.MANAGE_OVERLAY_PERMISSION');
}

/** Opens the "Do Not Disturb access" list; CallGuard needs it for the Pause button (silencing the ringer). */
export function openDoNotDisturbSettings() {
  return Linking.sendIntent('android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS');
}

/** Opens Android's default-apps settings, where "Caller ID & spam app" must be set to CallGuard for blocking to work. */
export function openCallerIdSettings() {
  return Linking.sendIntent('android.settings.MANAGE_DEFAULT_APPS_SETTINGS');
}
