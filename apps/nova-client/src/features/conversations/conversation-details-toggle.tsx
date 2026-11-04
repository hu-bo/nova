import { Button } from '@/components/ui/button';
import { usePreferences } from '@/features/settings';
import { PanelRight } from 'lucide-react';

export function ConversationDetailsToggle() {
  const { preferences, update } = usePreferences();
  return (
    <Button
      variant="ghost"
      isIconOnly
      aria-label={preferences.contextPanelOpen ? '收起任务详情' : '展开任务详情'}
      title={preferences.contextPanelOpen ? '收起任务详情' : '展开任务详情'}
      aria-pressed={preferences.contextPanelOpen}
      onPress={() => update({ contextPanelOpen: !preferences.contextPanelOpen })}
    >
      <PanelRight size={17} />
    </Button>
  );
}
