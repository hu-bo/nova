import { Description, Label, Switch } from '@heroui/react';
import { usePreferences } from './preferences.context';

export function ChatTab() {
  const { preferences, update } = usePreferences();
  return (
    <div className="space-y-5">
      <h2 className="text-xl font-semibold tracking-tight">聊天设置</h2>
      <div className="grid gap-4 rounded-xl border border-slate-200 p-4">
        <Switch
          isSelected={preferences.chatFullWidth}
          onChange={(chatFullWidth) => update({ chatFullWidth })}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>占满可用宽度</Label>
          </Switch.Content>
          <Description>开启后，聊天消息和输入框会铺满聊天区域。</Description>
        </Switch>
        <Switch
          isSelected={preferences.showToolCalls}
          onChange={(showToolCalls) => update({ showToolCalls })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Content>
            <Label>显示工具调用</Label>
            <Description>在聊天消息中显示工具名称、参数和执行状态。</Description>
          </Switch.Content>
        </Switch>
        <Switch
          isSelected={preferences.includeToolResults}
          onChange={(includeToolResults) => update({ includeToolResults })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Content>
            <Label>接收工具结果</Label>
            <Description>关闭后，服务端会省略实时消息、聊天历史和导出中的工具输出。</Description>
          </Switch.Content>
        </Switch>
      </div>
    </div>
  );
}
