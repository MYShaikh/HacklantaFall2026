import { useCallback, useEffect, useState } from 'react';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  BlockedNumber,
  Category,
  Reputation,
  SPAM_THRESHOLD,
  blockNumber,
  bulkLookup,
  fetchBlocklist,
  getAutoBlock,
  getServerUrl,
  loadToken,
  login,
  logout,
  lookupNumber,
  register,
  reportNumber,
  setAutoBlock,
  setServerUrl,
  syncScamCalls,
  syncSpamList,
  unblock,
  unblockAll,
} from './src/api';
import {
  CallItem,
  SmsItem,
  callVoicemail,
  loadCalls,
  loadSms,
  requestOptionalPermissions,
  requestPhonePermissions,
} from './src/device';
import { isScamLabel, normalizeNumber } from './src/phone';
import SetupTab from './SetupTab';

type Tab = 'calls' | 'texts' | 'voicemail' | 'blocked' | 'setup';
const CATEGORIES: Category[] = ['spam', 'scam', 'telemarketer', 'robocall', 'harassment', 'other'];

const fmtDate = (ms: number) => new Date(ms).toLocaleString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'calls', label: 'Calls', icon: '📞' },
  { key: 'texts', label: 'Texts', icon: '💬' },
  { key: 'voicemail', label: 'Voicemail', icon: '🎙️' },
  { key: 'blocked', label: 'Blocked', icon: '🚫' },
  { key: 'setup', label: 'Setup', icon: '⚙️' },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // Android draws apps behind the status bar, so leave room for the clock, Wi-Fi and battery icons.
  const insets = useSafeAreaInsets();

  useEffect(() => {
    loadToken().then(t => setAuthed(!!t));
  }, []);

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />
      {authed === null ? (
        <ActivityIndicator style={s.center} />
      ) : authed ? (
        <Main onLogout={() => logout().then(() => setAuthed(false))} />
      ) : (
        <Login onDone={() => setAuthed(true)} />
      )}
    </View>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState(getServerUrl());
  const [busy, setBusy] = useState(false);

  const submit = async (mode: 'login' | 'register') => {
    setBusy(true);
    try {
      await setServerUrl(server);
      await (mode === 'login' ? login : register)(username.trim(), password);
      onDone();
    } catch (e) {
      Alert.alert(mode === 'login' ? 'Login failed' : 'Sign up failed', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.login}>
      <Text style={s.title}>CallGuard</Text>
      <TextInput placeholderTextColor="#888" style={s.input} placeholder="Server address" autoCapitalize="none" keyboardType="url" value={server} onChangeText={setServer} />
      <TextInput placeholderTextColor="#888" style={s.input} placeholder="Username" autoCapitalize="none" value={username} onChangeText={setUsername} />
      <TextInput placeholderTextColor="#888" style={s.input} placeholder="Password (8+ chars)" secureTextEntry value={password} onChangeText={setPassword} />
      <Pressable style={s.primary} disabled={busy} onPress={() => submit('login')}>
        <Text style={s.primaryText}>Log in</Text>
      </Pressable>
      <Pressable style={s.secondary} disabled={busy} onPress={() => submit('register')}>
        <Text style={s.secondaryText}>Create account</Text>
      </Pressable>
    </View>
  );
}

function Main({ onLogout }: { onLogout: () => void }) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('calls');
  const [calls, setCalls] = useState<CallItem[]>([]);
  const [texts, setTexts] = useState<SmsItem[]>([]);
  const [blocked, setBlocked] = useState<BlockedNumber[]>([]);
  const [reporting, setReporting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reputation, setReputation] = useState<Record<string, Reputation>>({});
  const [spamCount, setSpamCount] = useState(0);
  const [autoBlock, setAutoBlockState] = useState(false);
  const [scamSummary, setScamSummary] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<string | null>(null);

  // The screening service shows a notification for each incoming call; tapping it (or the full-screen
  // intent on a locked phone) opens callguard://incoming?number=... which lands here.
  useEffect(() => {
    const handle = (url?: string | null) => {
      const m = url?.match(/^callguard:\/\/incoming\?number=(.+)$/);
      if (m) setIncoming(decodeURIComponent(m[1]));
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', e => handle(e.url));
    return () => sub.remove();
  }, []);

  /** Fetch report counts for these numbers and merge them into what we already know. */
  const loadReputation = useCallback(async (numbers: string[]) => {
    const unique = [...new Set(numbers.map(normalizeNumber).filter(Boolean))];
    if (!unique.length) return;
    const found = await bulkLookup(unique);
    setReputation(prev => {
      const next = { ...prev };
      unique.forEach(n => { next[n] = found[n] ?? { report_count: 0, top_category: null }; });
      return next;
    });
  }, []);

  /** Everything that needs the Django server. Runs after the lists are on screen, and never blocks them. */
  const syncWithServer = useCallback(
    async (c: CallItem[], t: SmsItem[]) => {
      const failures: string[] = [];
      const run = (work: Promise<unknown>) => work.catch(e => { failures.push(errMsg(e)); });

      // Calls the phone labelled "Scam Likely" etc. among the last 50: log, block and report them.
      const flagged = [...c]
        .sort((a, b) => b.date - a.date)
        .slice(0, 50)
        .filter(x => isScamLabel(x.name) && normalizeNumber(x.number));
      const sweep = flagged.length
        ? syncScamCalls(flagged.map(x => ({ number: x.number, label: x.name ?? '', called_at: x.date }))).then(() =>
            setScamSummary(`${flagged.length} of your last 50 calls were labelled scam by your phone — reported and logged. Calls from them show the red spam card.`),
          )
        : Promise.resolve(setScamSummary(null));

      // The sweep goes first so the block list and spam list below already include its results.
      await run(sweep);
      await Promise.all([
        run(fetchBlocklist().then(setBlocked)),
        run(syncSpamList().then(setSpamCount)),
        run(getAutoBlock().then(setAutoBlockState)),
        run(loadReputation([...c.map(x => x.number), ...t.map(x => x.address)])),
      ]);
      setServerError(failures.length ? `Can't reach the server at ${getServerUrl()} (${failures[0]})` : null);
    },
    [loadReputation],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    requestOptionalPermissions().catch(() => {}); // don't wait on this prompt
    try {
      if (await requestPhonePermissions()) {
        const [c, t] = await Promise.all([loadCalls(), loadSms()]);
        setCalls(c);
        setTexts(t);
        setLoading(false); // lists are visible now; the server work continues in the background
        await syncWithServer(c, t);
      } else {
        Alert.alert(
          'Permission needed',
          'Allow Call log and SMS access. On Android 13+ you may first need App info → ⋮ → "Allow restricted settings".',
        );
      }
    } catch (e) {
      Alert.alert('Could not load', errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [syncWithServer]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const blockedSet = new Set(blocked.map(b => b.number));

  const block = async (number: string) => {
    try {
      setBlocked(await blockNumber(number));
    } catch (e) {
      Alert.alert('Could not block', errMsg(e));
    }
  };

  const check = async (number: string) => {
    try {
      const r = await lookupNumber(number);
      Alert.alert(
        number,
        r.report_count ? `${r.report_count} report(s), mostly "${r.top_category}"` : 'No reports from other users yet.',
      );
    } catch (e) {
      Alert.alert('Lookup failed', errMsg(e));
    }
  };

  const NumberActions = ({ number }: { number: string }) => {
    const n = normalizeNumber(number);
    if (!n) return null;
    const rep = reputation[n];
    const isSpam = !!rep && rep.report_count >= SPAM_THRESHOLD;
    return (
      <View style={s.actions}>
        {!!rep?.report_count && (
          <Text style={[s.badge, isSpam ? s.badgeSpam : s.badgeWarn]}>
            {isSpam ? '⚠ Spam' : 'Reported'}{rep.top_category ? ` · ${rep.top_category}` : ''} · {rep.report_count}
          </Text>
        )}
        <Pressable onPress={() => check(n)}><Text style={s.link}>Check</Text></Pressable>
        {blockedSet.has(n) ? (
          <Text style={s.muted}>Blocked</Text>
        ) : (
          <Pressable onPress={() => block(n)}><Text style={s.link}>Block</Text></Pressable>
        )}
        <Pressable onPress={() => setReporting(n)}><Text style={[s.link, s.danger]}>Report</Text></Pressable>
      </View>
    );
  };

  return (
    <View style={s.screen}>
      <View style={s.content}>
      {tab === 'calls' && (
        <FlatList
          data={calls}
          keyExtractor={c => c.id}
          refreshing={loading}
          onRefresh={refresh}
          ListHeaderComponent={
            serverError || scamSummary ? (
              <View>
                {!!serverError && <Text style={[s.banner, s.bannerError]}>{serverError}</Text>}
                {!!scamSummary && <Text style={s.banner}>{scamSummary}</Text>}
              </View>
            ) : undefined
          }
          ListEmptyComponent={<Text style={s.empty}>No calls to show.</Text>}
          renderItem={({ item }) => (
            <View style={s.row}>
              <Text style={s.primaryLine}>{item.name || item.number}</Text>
              <Text style={s.muted}>{item.type.toLowerCase()} · {fmtDate(item.date)} · {item.duration}s</Text>
              <NumberActions number={item.number} />
            </View>
          )}
        />
      )}

      {tab === 'texts' && (
        <FlatList
          data={texts}
          keyExtractor={t => t.id}
          refreshing={loading}
          onRefresh={refresh}
          ListEmptyComponent={<Text style={s.empty}>No texts to show.</Text>}
          renderItem={({ item }) => (
            <View style={s.row}>
              <Text style={s.primaryLine}>{item.box === 'sent' ? 'To ' : 'From '}{item.address}</Text>
              <Text numberOfLines={2}>{item.body}</Text>
              <Text style={s.muted}>{fmtDate(item.date)}</Text>
              {item.box === 'inbox' && <NumberActions number={item.address} />}
            </View>
          )}
        />
      )}

      {tab === 'voicemail' && (
        <ScrollView contentContainerStyle={s.pad}>
          <Text style={s.primaryLine}>Voicemail</Text>
          <Text style={s.body}>
            Android doesn't let third-party apps read carrier voicemail, so CallGuard can't list your messages.
            This button dials your voicemail box instead.
          </Text>
          <Pressable style={s.primary} onPress={() => callVoicemail().catch(e => Alert.alert('Could not open', errMsg(e)))}>
            <Text style={s.primaryText}>Call voicemail</Text>
          </Pressable>

          <View style={s.note}>
            <Text style={s.primaryLine}>Recording a call</Text>
            <Text style={s.body}>
              CallGuard can't record calls: Android doesn't let apps capture the other person's voice.
              Google Voice can record calls you receive on your Google Voice number:
            </Text>
            <Text style={s.body}>
              {'1. Open Google Voice → Settings → Calls, and turn on "Incoming call options".\n'}
              {'2. When a call comes in, answer it and press 4 on the keypad to start recording. Press 4 again to stop.\n'}
              {'3. The recording appears in the Google Voice app, under Voicemail / Recorded calls.'}
            </Text>
            <Text style={s.body}>
              Everyone on the call hears an announcement when recording starts or stops. Laws on recording calls
              differ by state and country, and many places require every person's consent, so tell the caller first.
            </Text>
          </View>
        </ScrollView>
      )}

      {tab === 'blocked' && (
        <BlockedTab
          blocked={blocked}
          onAdd={block}
          onRemove={async id => setBlocked(await unblock(id))}
          onRemoveAll={async () => setBlocked(await unblockAll())}
        />
      )}

      {tab === 'setup' && (
        <SetupTab
          autoBlock={autoBlock}
          spamCount={spamCount}
          onToggleAutoBlock={async on => { setAutoBlockState(on); await setAutoBlock(on); }}
          onLogout={onLogout}
        />
      )}
      </View>

      <View style={[s.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {TABS.map(t => (
          <Pressable key={t.key} style={s.tabItem} onPress={() => setTab(t.key)}>
            <Text style={[s.tabIcon, tab !== t.key && s.tabIconInactive]}>{t.icon}</Text>
            <Text style={[s.tabLabel, tab === t.key && s.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      {incoming && (
        <IncomingCall
          number={incoming}
          isBlocked={blockedSet.has(normalizeNumber(incoming))}
          onBlock={() => block(normalizeNumber(incoming))}
          onReport={() => { setReporting(normalizeNumber(incoming)); setIncoming(null); }}
          onClose={() => setIncoming(null)}
        />
      )}

      <Modal transparent visible={!!reporting} animationType="fade" onRequestClose={() => setReporting(null)}>
        <View style={s.backdrop}>
          <View style={s.sheet}>
            <Text style={s.primaryLine}>Report {reporting}</Text>
            {CATEGORIES.map(c => (
              <Pressable
                key={c}
                style={s.option}
                onPress={async () => {
                  const number = reporting!;
                  setReporting(null);
                  try {
                    await reportNumber(number, c);
                    await Promise.all([loadReputation([number]), syncSpamList().then(setSpamCount)]);
                    Alert.alert('Reported', `${number} reported as ${c}.`);
                  } catch (e) {
                    Alert.alert('Could not report', errMsg(e));
                  }
                }}>
                <Text style={s.optionText}>{c}</Text>
              </Pressable>
            ))}
            <Pressable style={s.option} onPress={() => setReporting(null)}>
              <Text style={s.muted}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** Opened by the incoming-call notification: who is calling and whether others reported them. */
function IncomingCall(props: {
  number: string;
  isBlocked: boolean;
  onBlock: () => void;
  onReport: () => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState('Checking reports…');

  useEffect(() => {
    lookupNumber(props.number)
      .then(r =>
        setInfo(
          r.report_count >= SPAM_THRESHOLD
            ? `⚠ Likely spam — ${r.report_count} reports${r.top_category ? ` (${r.top_category})` : ''}`
            : r.report_count
            ? `${r.report_count} report so far`
            : 'No reports for this number',
        ),
      )
      .catch(() => setInfo('Could not check reports'));
  }, [props.number]);

  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={[s.backdrop, s.backdropCenter]}>
        <View style={[s.sheet, s.sheetCenter]}>
          <Text style={s.muted}>Incoming call</Text>
          <Text style={s.title}>{props.number}</Text>
          <Text style={s.body}>{info}</Text>
          {props.isBlocked ? (
            <Text style={s.muted}>This number is blocked.</Text>
          ) : (
            <Pressable style={s.primary} onPress={props.onBlock}>
              <Text style={s.primaryText}>Block this number</Text>
            </Pressable>
          )}
          <Pressable style={s.secondary} onPress={props.onReport}>
            <Text style={s.secondaryText}>Report</Text>
          </Pressable>
          <Pressable style={s.option} onPress={props.onClose}>
            <Text style={s.muted}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function BlockedTab(props: {
  blocked: BlockedNumber[];
  onAdd: (n: string) => void;
  onRemove: (id: number) => void;
  onRemoveAll: () => Promise<void>;
}) {
  const [text, setText] = useState('');

  return (
    <View style={s.screen}>
      <View style={s.pad}>
        <View style={s.addRow}>
          <TextInput placeholderTextColor="#888" style={[s.input, s.grow]} placeholder="Add number to block" keyboardType="phone-pad" value={text} onChangeText={setText} />
          <Pressable style={s.primary} onPress={() => { props.onAdd(text); setText(''); }}>
            <Text style={s.primaryText}>Block</Text>
          </Pressable>
        </View>
      </View>
      <FlatList
        data={props.blocked}
        keyExtractor={b => String(b.id)}
        ListEmptyComponent={<Text style={s.empty}>No blocked numbers.</Text>}
        renderItem={({ item }) => (
          <View style={[s.row, s.between]}>
            <Text style={s.primaryLine}>{item.number}</Text>
            <Pressable onPress={() => props.onRemove(item.id)}><Text style={s.link}>Unblock</Text></Pressable>
          </View>
        )}
      />
      {props.blocked.length > 0 && (
        <Pressable
          style={s.pad}
          onPress={() =>
            Alert.alert(
              'Unblock everyone?',
              `This removes all ${props.blocked.length} numbers you blocked in CallGuard. It does not change blocks in your phone's own settings or in Google Voice.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Unblock all',
                  style: 'destructive',
                  onPress: () => props.onRemoveAll().catch(e => Alert.alert('Could not unblock', errMsg(e))),
                },
              ],
            )
          }>
          <Text style={[s.link, s.danger]}>Unblock all ({props.blocked.length})</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1 },
  login: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '700', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16, color: '#111' },
  grow: { flex: 1 },
  primary: { backgroundColor: '#1a56db', borderRadius: 8, padding: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  secondary: { borderWidth: 1, borderColor: '#1a56db', borderRadius: 8, padding: 12, alignItems: 'center' },
  secondaryText: { color: '#1a56db', fontWeight: '600', fontSize: 16 },
  content: { flex: 1 },
  tabBar: { flexDirection: 'row', borderTopWidth: 1, borderColor: '#e5e7eb', backgroundColor: '#fff', paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center', gap: 2 },
  tabIcon: { fontSize: 24 },
  tabIconInactive: { opacity: 0.45 },
  tabLabel: { fontSize: 12, color: '#666' },
  tabLabelActive: { color: '#1a56db', fontWeight: '700' },
  row: { padding: 14, borderBottomWidth: 1, borderColor: '#f0f0f0', gap: 4 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  primaryLine: { fontSize: 16, fontWeight: '600' },
  muted: { color: '#777', fontSize: 13 },
  body: { fontSize: 15, color: '#333', lineHeight: 21 },
  empty: { textAlign: 'center', color: '#777', marginTop: 40 },
  actions: { flexDirection: 'row', gap: 20, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' },
  bannerError: { backgroundColor: '#fde8e8', color: '#c81e1e' },
  note: { backgroundColor: '#f3f4f6', borderRadius: 12, padding: 14, gap: 8, marginTop: 8 },
  banner: { backgroundColor: '#fef3c7', color: '#92400e', padding: 12, fontSize: 14 },
  badge: { fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden', textTransform: 'capitalize' },
  badgeSpam: { backgroundColor: '#fde8e8', color: '#c81e1e' },
  badgeWarn: { backgroundColor: '#fef3c7', color: '#92400e' },
  link: { color: '#1a56db', fontWeight: '600' },
  danger: { color: '#c81e1e' },
  pad: { padding: 16, gap: 12 },
  addRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', padding: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16, gap: 4 },
  backdropCenter: { justifyContent: 'center', padding: 20 },
  sheetCenter: { borderRadius: 16 },
  option: { padding: 14 },
  optionText: { fontSize: 16, textTransform: 'capitalize' },
});
