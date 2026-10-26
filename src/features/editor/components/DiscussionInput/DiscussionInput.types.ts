export type DiscussionInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sendDisabled: boolean;
};
