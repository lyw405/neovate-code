import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import PaginatedSelectInput from './PaginatedSelectInput';
import { useAppStore } from './store';

interface SnapshotInfo {
  messageUuid: string;
  parentMessageUuid: string | null;
  timestamp: string;
  operationCount: number;
  affectedFiles: string[];
  messageRole?: 'user' | 'assistant';
  messageTimestamp?: string;
  userPrompt?: string;
}

interface SnapshotModalProps {
  onClose: () => void;
}

export function SnapshotModal({ onClose }: SnapshotModalProps) {
  const { bridge, cwd, sessionId, log, isRestoringSnapshot } = useAppStore();
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Only listen to ESC when there's no PaginatedSelectInput (which has its own ESC handler)
  // This fixes the issue where snapshots.length === 0 or loading/error states can't be closed
  const hasSelectInput = !loading && !error && snapshots.length > 0;

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
      }
    },
    { isActive: !hasSelectInput },
  );

  useEffect(() => {
    bridge
      .request('session.listSnapshots', { cwd, sessionId })
      .then((result) => {
        if (result.success && Array.isArray(result.data?.snapshots)) {
          // Sort by timestamp descending (newest first)
          const sortedSnapshots = [...result.data.snapshots].sort(
            (a, b) =>
              new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
          );
          setSnapshots(sortedSnapshots);
        } else {
          setError(result.error?.message || 'Failed to load snapshots');
          setSnapshots([]);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch snapshots:', err);
        setError(err.message || 'Unknown error');
        setSnapshots([]);
        setLoading(false);
      });
  }, [cwd, sessionId, bridge]);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ago`;
    } else if (hours > 0) {
      return `${hours}h ago`;
    } else if (minutes > 0) {
      return `${minutes}m ago`;
    } else {
      return 'just now';
    }
  };

  const selectItems = snapshots.map((snapshot) => {
    const fileList = snapshot.affectedFiles.slice(0, 2).join(', ');
    const moreFiles =
      snapshot.affectedFiles.length > 2
        ? ` +${snapshot.affectedFiles.length - 2}`
        : '';

    // Truncate user prompt to 60 characters
    const promptPreview = snapshot.userPrompt
      ? snapshot.userPrompt.length > 60
        ? `${snapshot.userPrompt.substring(0, 60)}...`
        : snapshot.userPrompt
      : '';

    const label = [
      formatTime(snapshot.timestamp).padEnd(10),
      `${snapshot.operationCount} ops`.padEnd(8),
      `${fileList}${moreFiles}`.padEnd(30),
    ].join(' ');

    const fullLabel = promptPreview
      ? `${label}\n    💬 ${promptPreview}`
      : label;

    return {
      label: fullLabel,
      value: snapshot.messageUuid,
    };
  });

  if (loading) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text>Loading snapshots...</Text>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Press Esc to cancel
          </Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text color="red">Error: {error}</Text>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Press Esc to close
          </Text>
        </Box>
      </Box>
    );
  }

  if (snapshots.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text color="yellow">No snapshots found in this session.</Text>
        <Box marginTop={1}>
          <Text color="gray">
            Snapshots are created automatically when AI modifies files.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Press Esc to close
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Box marginBottom={1}>
        <Text bold>Restore Code Snapshot</Text>
        <Text color="gray" dimColor>
          Restore code and conversation to before selected snapshot
        </Text>
      </Box>
      {isRestoringSnapshot && (
        <Box marginBottom={1}>
          <Text color="yellow">⏳ Restoring snapshot, please wait...</Text>
        </Box>
      )}
      <Box marginBottom={1}>
        <Text color="gray">
          {'  '}
          {['Time'.padEnd(10), 'Changes'.padEnd(8), 'Files'].join(' ')}
        </Text>
      </Box>
      <Box>
        <PaginatedSelectInput
          items={selectItems}
          initialIndex={0}
          itemsPerPage={10}
          onSelect={async (item) => {
            const selectedSnapshot = snapshots.find(
              (s) => s.messageUuid === item.value,
            );

            const result = await bridge.request('session.restoreCode', {
              cwd,
              sessionId,
              targetMessageUuid: item.value,
            });

            if (result.success) {
              const data = result.data;

              // Auto-fill prompt to input box if available
              if (data.userPromptToFill) {
                useAppStore.setState({ inputValue: data.userPromptToFill });
              }

              // Reload messages to show the restore hint message
              const messagesResponse = await bridge.request(
                'session.messages.list',
                { cwd, sessionId },
              );
              if (messagesResponse.success) {
                useAppStore.setState({
                  messages: messagesResponse.data.messages,
                });
              }

              // Increment restoreCounter to force Static component re-render
              useAppStore.getState().incrementRestoreCounter();

              // Also log a summary in the logs panel
              const lines: string[] = [];

              if (selectedSnapshot?.userPrompt) {
                lines.push(
                  `📍 Restored to BEFORE: "${selectedSnapshot.userPrompt}"`,
                );
                lines.push(
                  '💡 Prompt filled in input box - edit and run again',
                );
              }

              if (data.restoredFiles.length > 0) {
                lines.push(
                  `✅ ${data.restoredFiles.length} file(s): ${data.restoredFiles.slice(0, 3).join(', ')}${data.restoredFiles.length > 3 ? ` +${data.restoredFiles.length - 3}` : ''}`,
                );
              }

              if (data.skippedBashFiles.length > 0) {
                lines.push(
                  `⏭️  Skipped ${data.skippedBashFiles.length} bash file(s)`,
                );
              }

              if (lines.length > 0) {
                log(lines.join('\n'));
              }

              onClose();
            } else {
              log(
                `❌ Restore failed: ${result.error?.message || 'Unknown error'}`,
              );
              onClose();
            }
          }}
          onCancel={onClose}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Press ↑↓ to navigate, Enter to restore, Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
