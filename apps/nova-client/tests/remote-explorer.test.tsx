import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadRemote: vi.fn(),
  loadRunner: vi.fn(),
  create: vi.fn(),
  bind: vi.fn(),
  navigate: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/features/auth', () => ({ useIdentity: () => ({ identity: { identityId: 'alice' } }) }));
vi.mock('@/features/models', () => ({
  useClientConfig: () => ({ data: { capabilities: { remoteFiles: true } } }),
}));
vi.mock('@/features/settings', () => ({ useModelSettings: () => ({ defaultRunnerId: '' }) }));
vi.mock('@/features/remotes', () => ({
  useRemoteConnectionsQuery: () => ({
    isPending: false,
    data: { items: [{ id: 'remote-1', name: 'Test SSH', rootPath: '/home', status: 'verified' }] },
  }),
  loadRemoteDirectory: mocks.loadRemote,
}));
vi.mock('@/features/runners', () => ({
  useRunnersQuery: () => ({
    isPending: false,
    data: { items: [{ id: 'runner-1', runnerId: 'Test Runner', workspaceId: 'workspace-1' }] },
  }),
  runnerStatus: () => 'online',
  loadRunnerDirectory: mocks.loadRunner,
}));
vi.mock('@/api/generated/projects', () => ({
  createProject: mocks.create,
  bindProjectEnvironment: mocks.bind,
}));
import { NewProjectDialog } from '../src/features/projects/new-project-dialog';

function directory(path: string, root = '/') {
  const names = path === root ? ['var'] : path.endsWith('var') ? ['www'] : [];
  return {
    root,
    path,
    parent: path === root ? null : path.slice(0, path.lastIndexOf('/')) || root,
    entries: names.map((name) => ({
      name,
      path: (path === '.' ? '' : path.replace(/\/$/, '') + '/') + name,
      kind: 'directory' as const,
    })),
  };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Host() {
    const [open, setOpen] = useState(true);
    return (
      <NewProjectDialog
        open={open}
        onClose={() => {
          mocks.close();
          setOpen(false);
        }}
      />
    );
  }
  return render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

async function chooseEnvironment(label: RegExp) {
  await userEvent.type(
    screen.getByRole('textbox', { name: '项目名称' }),
    'Keep this project draft',
  );
  await userEvent.click(screen.getByRole('button', { name: /运行环境/ }));
  await userEvent.click(await screen.findByRole('option', { name: label }));
  await userEvent.click(screen.getByRole('button', { name: '浏览', exact: true }));
  return screen.findByRole('dialog', { name: '选择项目工作目录' });
}

beforeEach(() => {
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-z\d_-]/gi, '\\$&') });
  mocks.loadRemote.mockImplementation(async (_id: string, path = '/') => directory(path));
  mocks.loadRunner.mockImplementation(async (_id: string, path = '.') => directory(path, '.'));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe('directory selection inside the new project dialog', () => {
  it.each([
    { environment: 'SSH', label: /Test SSH/, path: '/var/www' },
    { environment: 'Runner', label: /Test Runner/, path: 'var/www' },
  ])(
    'navigates and confirms $environment directories without closing or submitting the project',
    async ({ label, path }) => {
      mount();
      const dialog = await chooseEnvironment(label);
      await userEvent.dblClick(await within(dialog).findByRole('option', { name: 'var' }));
      await userEvent.dblClick(await within(dialog).findByRole('option', { name: 'www' }));
      await waitFor(() =>
        expect(
          within(dialog)
            .getByRole('button', { name: '选择', exact: true })
            .hasAttribute('disabled'),
        ).toBe(false),
      );
      expect(mocks.close).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: '选择', exact: true }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: '选择项目工作目录' })).toBeNull(),
      );
      expect((screen.getByRole('textbox', { name: '工作目录' }) as HTMLInputElement).value).toBe(
        path,
      );
      expect((screen.getByRole('textbox', { name: '项目名称' }) as HTMLInputElement).value).toBe(
        'Keep this project draft',
      );
      expect(
        screen.getByRole('button', { name: '创建项目', exact: true }).hasAttribute('disabled'),
      ).toBe(false);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.close).not.toHaveBeenCalled();
    },
  );

  it('keeps navigation, cancellation, Escape and focus inside the directory dialog', async () => {
    mount();
    const dialog = await chooseEnvironment(/Test SSH/);
    await userEvent.dblClick(await within(dialog).findByRole('option', { name: 'var' }));
    await within(dialog).findByRole('option', { name: 'www' });
    await userEvent.click(within(dialog).getByRole('listbox', { name: '目录内容' }));
    await userEvent.keyboard('{Enter}');
    await within(dialog).findByText('此目录为空');
    expect(mocks.create).not.toHaveBeenCalled();
    await userEvent.keyboard('{Backspace}');
    await within(dialog).findByRole('option', { name: 'www' });
    await userEvent.click(within(dialog).getByRole('button', { name: '上级目录' }));
    await within(dialog).findByRole('option', { name: 'var' });
    await userEvent.click(within(dialog).getByRole('button', { name: '后退' }));
    await within(dialog).findByRole('option', { name: 'www' });
    await userEvent.click(within(dialog).getByRole('button', { name: '前进' }));
    await within(dialog).findByRole('option', { name: 'var' });
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: '取消', exact: true }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择项目工作目录' })).toBeNull(),
    );
    expect((screen.getByRole('textbox', { name: '工作目录' }) as HTMLInputElement).value).toBe('/');
    await userEvent.click(screen.getByRole('button', { name: '浏览', exact: true }));
    await screen.findByRole('dialog', { name: '选择项目工作目录' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '选择项目工作目录' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeTruthy();
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
