import { Check, ChevronRight, Circle, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FieldToggle, GlassButton } from '@/components/glass';
import { MCP_CLIENTS, type McpClientDefinition, type McpClientId } from '@/lib/adapters';
import { platformRuntime } from '@/lib/platform/runtime';
import { useMcpStore, type McpActivity } from '@/lib/state/mcpStore';
import { useSettingsStore } from '@/lib/state/settingsStore';
import { cn } from '@/lib/utils/cn';

export function AgentSettings() {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  const status = useMcpStore((state) => state.status);
  const pending = useMcpStore((state) => state.pending);
  const error = useMcpStore((state) => state.error);
  const setupResult = useMcpStore((state) => state.setupResult);
  const activities = useMcpStore((state) => state.activities);
  const setEnabled = useMcpStore((state) => state.setEnabled);
  const setPreferredPort = useMcpStore((state) => state.setPreferredPort);
  const setScope = useMcpStore((state) => state.setScope);
  const rotateToken = useMcpStore((state) => state.rotateToken);
  const writeClientConfig = useMcpStore((state) => state.writeClientConfig);
  const clearActivity = useMcpStore((state) => state.clearActivity);
  const [port, setPort] = useState(String(settings.mcpPort));
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<McpClientId | null>(null);

  if (!platformRuntime.capabilities.mcpServer) {
    return <p className="text-[13px] text-nb-text-3">{t('mcp.desktopOnly')}</p>;
  }

  async function setup(client: McpClientId) {
    try {
      const result = await writeClientConfig(client);
      if (client === 'custom') {
        await navigator.clipboard.writeText(result);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
      }
    } catch {
      // The store owns the user-visible error.
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-nb-sm border border-[var(--nb-divider)] bg-[var(--nb-hover)] p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[13px]">
              <Circle
                size={9}
                fill={status.running ? 'var(--nb-success)' : 'var(--nb-text-3)'}
                className={status.running ? 'text-[var(--nb-success)]' : 'text-nb-text-3'}
                aria-hidden
              />
              {status.running
                ? t('mcp.running', { port: status.port })
                : t('mcp.stopped')}
            </div>
            <p className="mt-1 text-[11px] text-nb-text-3">{t('mcp.loopbackHint')}</p>
          </div>
          <FieldToggle
            label={t('mcp.enable')}
            checked={settings.mcpEnabled}
            disabled={pending}
            onChange={(enabled) => void setEnabled(enabled)}
          />
        </div>

        <div className="mt-3 flex items-end gap-2 border-t border-[var(--nb-divider)] pt-3">
          <label className="flex flex-col gap-1 text-[11px] text-nb-text-3">
            {t('mcp.preferredPort')}
            <input
              type="number"
              min={1024}
              max={65525}
              value={port}
              disabled={pending}
              onChange={(event) => setPort(event.target.value)}
              onBlur={() => {
                const next = Number(port);
                if (next !== settings.mcpPort) void setPreferredPort(next);
              }}
              className="h-7 w-28 rounded-nb-xs border border-[var(--nb-control-border)] bg-[var(--nb-control-surface)] px-2 text-[12px] text-nb-text focus:outline-none focus:ring-2 focus:ring-[var(--nb-accent-ring)]"
            />
          </label>
          <GlassButton size="sm" disabled={pending} onClick={() => void rotateToken()}>
            <RefreshCw size={12} aria-hidden />
            {t('mcp.rotateToken')}
          </GlassButton>
          <FieldToggle
            label={t('mcp.allowWrites')}
            checked={settings.mcpScope === 'write'}
            disabled={pending}
            onChange={(enabled) => void setScope(enabled ? 'write' : 'read')}
          />
        </div>
      </div>

      {/* Same shape as the AI provider list: one row per client, expanded to
          show exactly which file is about to be edited. Five buttons in a row
          told the student nothing about what pressing one would do. */}
      <div>
        <h3 className="text-[13px] font-medium">{t('mcp.clientSetup')}</h3>
        <p className="mt-0.5 text-[11px] text-nb-text-3">{t('mcp.clientSetupHint')}</p>

        <ul className="mt-2 divide-y divide-[var(--nb-divider)] overflow-hidden rounded-nb-sm border border-[var(--nb-divider)]">
          {MCP_CLIENTS.map((client) => (
            <ClientRow
              key={client.id}
              client={client}
              open={expanded === client.id}
              busy={pending}
              ready={status.running}
              onToggle={() =>
                setExpanded((current) => (current === client.id ? null : client.id))
              }
              onSetup={() => void setup(client.id)}
            />
          ))}
          <li className="flex items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1 text-[13px]">{t('mcp.otherClient')}</span>
            <GlassButton
              size="sm"
              disabled={!status.running || pending}
              onClick={() => void setup('custom')}
            >
              {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
              {copied ? t('mcp.copied') : t('mcp.copyConfig')}
            </GlassButton>
          </li>
        </ul>

        {setupResult && (
          <p className="mt-2 break-all text-[11px] text-[var(--nb-success)]">
            {setupResult === 'custom'
              ? t('mcp.configCopied')
              : t('mcp.configWritten', { path: setupResult })}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[11px] text-[var(--nb-danger)]">
            {error}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[13px] font-medium">{t('mcp.activityTitle')}</h3>
            <p className="mt-0.5 text-[11px] text-nb-text-3">{t('mcp.activityHint')}</p>
          </div>
          {activities.length > 0 && (
            <GlassButton size="sm" variant="ghost" onClick={clearActivity}>
              <Trash2 size={12} aria-hidden />
              {t('mcp.clearActivity')}
            </GlassButton>
          )}
        </div>
        <div className="mt-2 max-h-40 overflow-y-auto rounded-nb-sm border border-[var(--nb-divider)]">
          {activities.length === 0 ? (
            <p className="p-3 text-[11px] text-nb-text-3">{t('mcp.noActivity')}</p>
          ) : (
            <ul className="divide-y divide-[var(--nb-divider)]">
              {activities.map((activity) => (
                <ActivityRow key={activity.id} activity={activity} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ClientRow({
  client,
  open,
  busy,
  ready,
  onToggle,
  onSetup,
}: {
  client: McpClientDefinition;
  open: boolean;
  busy: boolean;
  ready: boolean;
  onToggle(): void;
  onSetup(): void;
}) {
  const { t } = useTranslation();

  return (
    <li className={cn(open && 'bg-[var(--nb-inset-surface)]')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--nb-hover)]"
      >
        <ChevronRight
          size={13}
          aria-hidden
          className={cn(
            'shrink-0 text-nb-text-3 transition-transform duration-[var(--nb-t-fast)]',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px]">{client.label}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-[var(--nb-divider)] px-3 py-2.5">
          <p className="text-[11px] leading-snug text-nb-text-3">{t(client.hintKey)}</p>
          <p className="text-[11px] text-nb-text-3">
            {t('mcp.willWrite')}{' '}
            <code className="break-all font-mono text-nb-text-2">{client.path}</code>
          </p>
          <GlassButton size="sm" disabled={!ready || busy} onClick={onSetup}>
            {t('mcp.configure')}
          </GlassButton>
          {!ready && <p className="text-[11px] text-nb-text-3">{t('mcp.enableFirst')}</p>}
        </div>
      )}
    </li>
  );
}

function ActivityRow({ activity }: { activity: McpActivity }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-[11px]">
      <Circle
        size={8}
        fill={
          activity.status === 'running'
            ? 'var(--nb-accent)'
            : activity.status === 'succeeded'
              ? 'var(--nb-success)'
              : 'var(--nb-danger)'
        }
        className={cn(
          'mt-1 shrink-0',
          activity.status === 'running'
            ? 'text-[var(--nb-accent)]'
            : activity.status === 'succeeded'
              ? 'text-[var(--nb-success)]'
              : 'text-[var(--nb-danger)]',
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-nb-text">
          {t(`mcp.tool_${activity.method}`, { defaultValue: activity.method })}
          {activity.noteTitle
            ? ` · ${activity.noteTitle}`
            : activity.noteId
              ? ` · ${activity.noteId}`
              : ''}
        </p>
        <p className="truncate text-nb-text-3">
          {activity.agentName || t('mcp.unknownClient')} ·{' '}
          {new Date(activity.startedAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
          {activity.error ? ` · ${activity.error}` : ''}
        </p>
      </div>
    </li>
  );
}
