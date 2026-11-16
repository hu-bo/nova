import { Button } from '@/components/ui/button';

export function CareerCoachTasks({
  onSelect,
  includeFinish = true,
}: {
  onSelect: (text: string) => void;
  includeFinish?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2 py-3" aria-label="求职任务">
      <Button
        variant="secondary"
        onPress={() =>
          onSelect(
            '请帮我修改简历。先诊断已有材料，并针对目标岗位改写。\n\n我的简历：\n\n目标岗位或 JD（可选）：\n',
          )
        }
      >
        修改简历
      </Button>
      <Button
        variant="secondary"
        onPress={() =>
          onSelect(
            '请根据我的经历开展模拟面试，每轮只问一个问题。\n模式：陪练（可改为仿真，结束后集中反馈）\n目标岗位：\n简历或经历：\n',
          )
        }
      >
        模拟面试
      </Button>
      {includeFinish && (
        <Button
          variant="ghost"
          onPress={() =>
            onSelect('结束面试。请仅依据本次实际问答复盘，给出具体改进建议和下一次练习重点。')
          }
        >
          结束面试
        </Button>
      )}
    </div>
  );
}
