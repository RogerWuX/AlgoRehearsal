import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Assessment } from '../judgment/model';
import type { JudgmentState } from '../judgment/state';

type Props = { judgment: JudgmentState; retryConfigured: boolean; onRetry: () => void; onCancel: () => void; onOpenSettings: () => void };

function Feedback({ title, assessment, error }: { title: string; assessment: Assessment | null; error?: string }) {
  return <View style={styles.section}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {assessment ? <>
      <Text selectable style={styles.text}>{assessment.summary}</Text>
      {assessment.perspectives.map(item => <View key={item.perspective} style={styles.dimension}>
        <Text accessibilityRole="header" style={styles.label}>{item.perspective}</Text>
        <Text selectable style={styles.text}>{item.feedback}</Text>
      </View>)}
      <Text accessibilityRole="header" style={styles.label}>Strengths</Text>
      {assessment.strengths.length ? assessment.strengths.map((text, index) => <Text key={index} selectable style={styles.text}>• {text}</Text>)
        : <Text style={styles.note}>No strengths could be established from the available evidence.</Text>}
      <Text accessibilityRole="header" style={styles.label}>Improvements</Text>
      {assessment.improvements.map((text, index) => <Text key={index} selectable style={styles.text}>• {text}</Text>)}
    </> : <Text accessibilityRole={error ? 'alert' : undefined} style={error ? styles.error : styles.note}>
      {error || 'Waiting for this assessment…'}
    </Text>}
  </View>;
}

export default function ResultsPanel({ judgment, retryConfigured, onRetry, onCancel, onOpenSettings }: Props) {
  if (!judgment.submission) return <View style={styles.panel}><Text style={styles.note}>End an interview to receive code and interview feedback.</Text></View>;
  const running = judgment.status === 'running';
  return <View style={styles.panel}>
    <Text accessibilityRole="header" style={styles.title}>Interview results</Text>
    <Text selectable style={styles.label}>{judgment.submission.problem.title}</Text>
    <Text style={styles.note}>{judgment.submission.language} · Submitted {new Date(judgment.submission.submittedAt).toLocaleString()}</Text>
    <Text style={styles.note}>Feedback applies to the code, discussion, and transcript captured when you ended the interview.</Text>
    {running && <View style={styles.section}>
      <Text accessibilityLiveRegion="polite" style={styles.text}>Judging {judgment.phase === 'interview' ? 'interview performance' : 'code'}…</Text>
      <Pressable accessibilityRole="button" onPress={onCancel} style={styles.button}><Text style={styles.buttonText}>Cancel grading</Text></Pressable>
    </View>}
    <Feedback title="Code feedback" assessment={judgment.code} error={judgment.errors.code} />
    <Feedback title="Interview feedback" assessment={judgment.interview} error={judgment.errors.interview} />
    {!running && (!judgment.code || !judgment.interview) && <Pressable accessibilityRole="button" onPress={retryConfigured ? onRetry : onOpenSettings} style={styles.button}>
      <Text style={styles.buttonText}>{retryConfigured ? 'Retry unfinished judgments' : 'Open Thinking settings'}</Text>
    </Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  panel: { padding: 20, gap: 12 },
  section: { gap: 12, paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#edf0f4' },
  dimension: { gap: 6 },
  title: { color: '#192334', fontSize: 18, fontWeight: '700' },
  label: { color: '#334e78', fontSize: 14, fontWeight: '600' },
  text: { color: '#192334', fontSize: 14, lineHeight: 22 },
  note: { color: '#64748b', fontSize: 12, lineHeight: 18 },
  error: { color: '#b42318', fontSize: 13, lineHeight: 20 },
  button: { alignSelf: 'flex-start', padding: 12, borderRadius: 8, backgroundColor: '#e9eef5' },
  buttonText: { color: '#334e78', fontSize: 13, fontWeight: '600' },
});
