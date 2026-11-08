import { useMemo, useState } from 'react';
import { Description, Header, Input, Label, ListBox, Popover } from '@heroui/react';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Cpu, Plus, Search, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIdentity } from '@/features/auth';
import { LocalStore } from '@/lib/local-store';
import type { ModelProfile } from '@/features/settings';

export function ModelPicker({
  profiles,
  value,
  onChange,
  loading,
  disabled,
}: {
  profiles: ModelProfile[];
  value: string;
  onChange: (id: string) => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const navigate = useNavigate();
  const { identity } = useIdentity();
  const favoriteStore = useMemo(
    () => new LocalStore<string[]>('nova_model_favorites:' + (identity?.identityId ?? ''), []),
    [identity?.identityId],
  );
  const [favorites, setFavorites] = useState(() => favoriteStore.get());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const selected = profiles.find((profile) => profile.id === value);
  const filtered = profiles.filter(
    (profile) =>
      (!onlyFavorites || favorites.includes(profile.id)) &&
      (profile.model + ' ' + profile.providerName)
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const groups = [...new Set(filtered.map((profile) => profile.providerName))];
  let emptyMessage = '尚未配置可用模型';
  if (query) {
    emptyMessage = '没有匹配的模型';
  } else if (onlyFavorites) {
    emptyMessage = '还没有收藏的模型';
  } else if (loading) {
    emptyMessage = '正在加载模型目录…';
  }

  function choose(id: string) {
    onChange(id);
    setOpen(false);
  }
  function configure() {
    setOpen(false);
    void navigate({ to: '/settings/models' });
  }
  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery('');
      }}
    >
      <Button
        variant="ghost"
        disabled={Boolean(disabled)}
        aria-label="选择模型"
        title={selected ? selected.model + ' · ' + selected.providerName : '选择或配置模型'}
      >
        <Cpu size={15} />
        <span className="max-w-36 truncate text-xs sm:max-w-48">
          {selected?.model ?? (loading ? '加载模型…' : '选择模型')}
        </span>
        <ChevronDown size={12} />
      </Button>
      <Popover.Content placement="top end" className="z-50 w-[min(370px,calc(100vw-24px))]">
        <Popover.Dialog>
          <div className="flex items-center gap-2">
            <Search size={16} className="shrink-0 text-slate-400" />
            <Input
              autoFocus
              aria-label="搜索模型"
              placeholder="搜索模型或 Provider"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && filtered[0]) {
                  event.preventDefault();
                  choose(filtered[0].id);
                }
              }}
            />
          </div>
          <div className="my-2 flex items-center gap-1">
            <Button
              size="sm"
              variant={!onlyFavorites ? 'secondary' : 'ghost'}
              onPress={() => setOnlyFavorites(false)}
            >
              全部模型
            </Button>
            <Button
              size="sm"
              variant={onlyFavorites ? 'secondary' : 'ghost'}
              onPress={() => setOnlyFavorites(true)}
            >
              <Star size={13} />
              收藏
            </Button>
          </div>
          {filtered.length ? (
            <ListBox
              aria-label="模型列表"
              className="max-h-72 overflow-y-auto"
              selectionMode="single"
              selectedKeys={new Set(value ? [value] : [])}
              onSelectionChange={(keys) => {
                const key = keys === 'all' ? undefined : Array.from(keys)[0];
                if (key !== undefined) choose(String(key));
              }}
              onAction={(key) => choose(String(key))}
            >
              {groups.map((group) => (
                <ListBox.Section key={group} id={group}>
                  <Header>{group}</Header>
                  {filtered
                    .filter((profile) => profile.providerName === group)
                    .map((profile) => (
                      <ListBox.Item key={profile.id} id={profile.id} textValue={profile.model}>
                        <div className="min-w-0 flex-1">
                          <Label className="block truncate">{profile.model}</Label>
                          <Description>
                            {new Intl.NumberFormat('en', { notation: 'compact' }).format(
                              profile.contextWindow,
                            )}{' '}
                            上下文{profile.supportsImages ? ' · 图片' : ''}
                            {profile.thinkingLevels.length ? ' · 推理' : ''}
                          </Description>
                        </div>
                        {favorites.includes(profile.id) && (
                          <Star size={12} className="shrink-0 text-amber-500" />
                        )}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                </ListBox.Section>
              ))}
            </ListBox>
          ) : (
            <div className="py-8 text-center text-sm text-slate-500">{emptyMessage}</div>
          )}
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2">
            <Button variant="ghost" onPress={configure}>
              <Plus size={14} />
              配置模型
            </Button>
            {selected && (
              <Button
                variant="ghost"
                aria-label={favorites.includes(value) ? '取消收藏当前模型' : '收藏当前模型'}
                onPress={() => {
                  const next = favorites.includes(value)
                    ? favorites.filter((id) => id !== value)
                    : [...favorites, value];
                  favoriteStore.set(next);
                  setFavorites(next);
                }}
              >
                <Star size={14} />
                {favorites.includes(value) ? '已收藏' : '收藏所选'}
              </Button>
            )}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
