import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Linking, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import DefaultPreference from 'react-native-default-preference';
import { getServerUrl } from './src/api';
import {
  openCallerIdSettings,
  openDoNotDisturbSettings,
  openOverlaySettings,
  requestPhonePermissions,
} from './src/device';

// 'ok' = confirmed on. 'todo' = confirmed off. 'unknown' = Android doesn't let an app check this one.
type Status = 'ok' | 'todo' | 'unknown';

type Item = {
  key: string;
  title: string;
  why: string;
  required: boolean;
  status: Status;
  hint?: string;
  button: string;
  action: () => Promise<unknown> | void;
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const granted = (permission: Parameters<typeof PermissionsAndroid.check>[0]) =>
  PermissionsAndroid.check(permission).catch(() => false);

export default function SetupTab(props: {
  autoBlock: boolean;
  spamCount: number;
  onToggleAutoBlock: (on: boolean) => void;
  onLogout: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [lastCall, setLastCall] = useState('');

  const load = useCallback(async () => {
    const P = PermissionsAndroid.PERMISSIONS;
    const [callLog, sms, answer, notifications] = await Promise.all([
      granted(P.READ_CALL_LOG),
      granted(P.READ_SMS),
      granted(P.ANSWER_PHONE_CALLS),
      typeof Platform.Version === 'number' && Platform.Version >= 33 ? granted(P.POST_NOTIFICATIONS) : Promise.resolve(true),
    ]);

    // The call-screening service writes this each time Android hands it a call. It is the only way to know
    // the Caller ID & spam setting and the overlay permission are on, since apps can't query them directly.
    const last = await DefaultPreference.get('last_screened');
    const overlayError = await DefaultPreference.get('last_overlay_error');
    const [time, number, decision = ''] = (last ?? '').split('|');
    const screened = !!last;
    const overlay: Status = decision.includes('overlay permission missing') ? 'todo' : decision.includes('card requested') ? 'ok' : 'unknown';

    setLastCall(
      screened
        ? `${new Date(Number(time)).toLocaleString()}\nNumber: ${number || '(hidden)'}\nResult: ${decision}` +
            (overlayError ? `\nOverlay error: ${overlayError}` : '')
        : 'No call has been screened yet. Receive a call after finishing the steps above.',
    );

    const askPermission = (permission: Parameters<typeof PermissionsAndroid.request>[0]) => async () => {
      const result = await PermissionsAndroid.request(permission);
      // After a refusal Android stops showing the prompt, so send the user to the app's settings page.
      if (result !== PermissionsAndroid.RESULTS.GRANTED) await Linking.openSettings();
      load();
    };

    setItems([
      {
        key: 'logs',
        title: 'Call log and texts',
        why: 'Lets CallGuard list your calls and texts.',
        required: true,
        status: callLog && sms ? 'ok' : 'todo',
        hint: 'If Android says access was denied, open the app info page → ⋮ (top right) → "Allow restricted settings", then try again.',
        button: 'Allow',
        action: async () => {
          if (!(await requestPhonePermissions())) await Linking.openSettings();
          load();
        },
      },
      {
        key: 'role',
        title: 'Caller ID & spam app',
        why: 'Choose CallGuard in the list. Without this Android never tells CallGuard a call is coming in, so no cards, no red button and no blocking.',
        required: true,
        status: screened ? 'ok' : 'unknown',
        hint: screened ? undefined : 'Shows ✓ after CallGuard has screened its first call. Settings → Apps → Default apps → Caller ID & spam app.',
        button: 'Open settings',
        action: () => openCallerIdSettings(),
      },
      {
        key: 'overlay',
        title: 'Pop-up over other apps',
        why: 'Lets the call card appear on top of YouTube, your home screen and other apps.',
        required: true,
        status: overlay,
        hint: overlay === 'unknown' ? 'Find CallGuard in the list and turn on "Allow display over other apps". Confirmed after your next call.' : undefined,
        button: 'Open settings',
        action: () => openOverlaySettings(),
      },
      {
        key: 'hangup',
        title: 'Hang up from the red button',
        why: 'Needs the "Answer phone calls" permission, so the red button can end a spam call.',
        required: false,
        status: answer ? 'ok' : 'todo',
        button: 'Allow',
        action: askPermission(P.ANSWER_PHONE_CALLS),
      },
      {
        key: 'notifications',
        title: 'Notifications',
        why: 'Used to wake the call card when the phone is locked.',
        required: false,
        status: notifications ? 'ok' : 'todo',
        button: 'Allow',
        action: askPermission(P.POST_NOTIFICATIONS),
      },
      {
        key: 'pause',
        title: 'Pause button',
        why: 'Silences the ringer without hanging up. Needs "Do Not Disturb access": find CallGuard in the list and turn it on.',
        required: false,
        status: 'unknown',
        hint: "Android doesn't let apps check this one, so it never shows ✓.",
        button: 'Open settings',
        action: () => openDoNotDisturbSettings(),
      },
    ]);
  }, []);

  useEffect(() => {
    load();
    // Re-check when the user comes back from a settings page.
    const sub = AppState.addEventListener('change', state => state === 'active' && load());
    return () => sub.remove();
  }, [load]);

  const confirmed = items.filter(i => i.status === 'ok').length;
  const missing = items.filter(i => i.required && i.status === 'todo');

  return (
    <ScrollView contentContainerStyle={s.pad}>
      <View style={s.summary}>
        <Text style={s.summaryTitle}>{confirmed} of {items.length} steps confirmed</Text>
        <Text style={s.muted}>
          {missing.length
            ? `Still needed: ${missing.map(m => m.title).join(', ')}.`
            : 'Steps marked ○ can\'t be checked by Android; they\'re confirmed after your next call, or never.'}
        </Text>
      </View>

      {items.map(item => (
        <View key={item.key} style={s.item}>
          <View style={s.itemHeader}>
            <Text style={[s.mark, item.status === 'ok' ? s.markOk : item.status === 'todo' ? s.markTodo : s.markUnknown]}>
              {item.status === 'ok' ? '✓' : item.status === 'todo' ? '✗' : '○'}
            </Text>
            <Text style={s.itemTitle}>
              {item.title}
              {item.required ? '' : ' (optional)'}
            </Text>
          </View>
          <Text style={s.body}>{item.why}</Text>
          {!!item.hint && <Text style={s.muted}>{item.hint}</Text>}
          {item.status !== 'ok' && (
            <Pressable
              style={s.button}
              onPress={() => Promise.resolve(item.action()).catch(e => Alert.alert('Could not open', errMsg(e)))}>
              <Text style={s.buttonText}>{item.button}</Text>
            </Pressable>
          )}
        </View>
      ))}

      <Text style={s.section}>Options</Text>
      <View style={[s.item, s.between]}>
        <View style={s.grow}>
          <Text style={s.itemTitle}>Silently reject known spam</Text>
          <Text style={s.muted}>
            {props.autoBlock
              ? `On: calls from the ${props.spamCount} known spam numbers are rejected with no warning.`
              : `Off: calls from the ${props.spamCount} known spam numbers ring through and show the red card.`}
          </Text>
        </View>
        <Switch value={props.autoBlock} onValueChange={props.onToggleAutoBlock} />
      </View>

      <Text style={s.section}>Last screened call</Text>
      <View style={s.item}>
        <Text style={s.body}>{lastCall}</Text>
        <Pressable onPress={load}><Text style={s.link}>Refresh</Text></Pressable>
      </View>

      <Text style={s.section}>Account</Text>
      <View style={s.item}>
        <Text style={s.muted}>Server: {getServerUrl()}</Text>
        <Pressable onPress={props.onLogout}><Text style={[s.link, s.danger]}>Log out</Text></Pressable>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  pad: { padding: 16, gap: 12 },
  summary: { backgroundColor: '#eff6ff', borderRadius: 12, padding: 14, gap: 4 },
  summaryTitle: { fontSize: 18, fontWeight: '700', color: '#1a56db' },
  item: { backgroundColor: '#f9fafb', borderRadius: 12, padding: 14, gap: 8 },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  itemTitle: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  mark: { fontSize: 20, fontWeight: '800', width: 24, textAlign: 'center' },
  markOk: { color: '#047857' },
  markTodo: { color: '#c81e1e' },
  markUnknown: { color: '#9ca3af' },
  body: { fontSize: 15, color: '#333', lineHeight: 21 },
  muted: { color: '#6b7280', fontSize: 13, lineHeight: 18 },
  button: { borderWidth: 1, borderColor: '#1a56db', borderRadius: 8, padding: 10, alignItems: 'center' },
  buttonText: { color: '#1a56db', fontWeight: '600', fontSize: 15 },
  section: { fontSize: 13, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', marginTop: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  grow: { flex: 1, gap: 4 },
  link: { color: '#1a56db', fontWeight: '600' },
  danger: { color: '#c81e1e' },
});
