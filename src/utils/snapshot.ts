import fs from 'fs';
import path from 'pathe';
import type { FileOperation, FileSnapshot } from '../session';

/**
 * Get max file size from config or use default
 */
export function getMaxFileSize(configSize?: number): number {
  return configSize || 512000; // 500KB default
}

/**
 * Turn-level snapshot collector
 * Collects file operations during one assistant turn
 */
export class TurnSnapshotCollector {
  private operations: Map<string, FileOperation> = new Map();
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Add a file operation to the collector
   */
  addOperation(operation: FileOperation): void {
    const absolutePath = path.isAbsolute(operation.path)
      ? operation.path
      : path.resolve(this.cwd, operation.path);

    // Store with absolute path as key to handle duplicates
    this.operations.set(absolutePath, {
      ...operation,
      path: absolutePath,
    });
  }

  /**
   * Create a snapshot from collected operations
   */
  createSnapshot(
    messageUuid: string,
    parentMessageUuid: string | null,
    userPrompt?: string,
  ): FileSnapshot | null {
    if (this.operations.size === 0) {
      return null;
    }

    return {
      messageUuid,
      parentMessageUuid,
      timestamp: new Date().toISOString(),
      operations: Array.from(this.operations.values()),
      userPrompt,
    };
  }

  /**
   * Clear collected operations
   */
  clear(): void {
    this.operations.clear();
  }
}

/**
 * Check if file should be tracked for snapshot
 */
export function shouldTrackFile(
  filePath: string,
  maxFileSize?: number,
): boolean {
  const MAX_FILE_SIZE = getMaxFileSize(maxFileSize);

  if (!fs.existsSync(filePath)) {
    return true; // Track deletions
  }

  const stats = fs.statSync(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    return false; // Skip files larger than 500KB
  }

  // Skip binary files (basic check)
  try {
    const buffer = Buffer.alloc(512);
    const fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);

    // Check for null bytes (indicator of binary file)
    // Only check the bytes actually read from the file
    if (buffer.subarray(0, bytesRead).includes(0)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Restore files from snapshot operations
 */
export interface RestoreResult {
  success: boolean;
  restoredFiles: string[];
  skippedBashFiles: string[];
  skippedLargeFiles: string[];
  errors: Array<{ file: string; error: string }>;
}

export function restoreFilesFromOperations(
  operations: FileOperation[],
  cwd: string,
  maxFileSize?: number,
): RestoreResult {
  const result: RestoreResult = {
    success: true,
    restoredFiles: [],
    skippedBashFiles: [],
    skippedLargeFiles: [],
    errors: [],
  };

  for (const operation of operations) {
    try {
      const absolutePath = path.isAbsolute(operation.path)
        ? operation.path
        : path.resolve(cwd, operation.path);

      // Skip bash tool files
      if (operation.source === 'bash') {
        result.skippedBashFiles.push(operation.path);
        continue;
      }

      // Skip if file is too large
      if (!shouldTrackFile(absolutePath, maxFileSize)) {
        result.skippedLargeFiles.push(operation.path);
        continue;
      }

      // Apply operation
      switch (operation.type) {
        case 'create':
        case 'modify':
          if (
            operation.content !== undefined ||
            operation.afterContent !== undefined
          ) {
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            // For modify operations, use afterContent (state after operation)
            // For create operations, use content (which is already the after state)
            const contentToWrite =
              operation.type === 'modify' &&
              operation.afterContent !== undefined
                ? operation.afterContent
                : operation.content;
            if (contentToWrite !== undefined) {
              fs.writeFileSync(absolutePath, contentToWrite, 'utf-8');
              result.restoredFiles.push(operation.path);
            }
          }
          break;

        case 'delete':
          if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            result.restoredFiles.push(operation.path);
          }
          break;
      }
    } catch (error) {
      result.success = false;
      result.errors.push({
        file: operation.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Revert snapshot operations (undo the changes)
 * This is used when restoring to BEFORE a snapshot
 */
export function revertSnapshotOperations(
  operations: FileOperation[],
  cwd: string,
  maxFileSize?: number,
): RestoreResult {
  const result: RestoreResult = {
    success: true,
    restoredFiles: [],
    skippedBashFiles: [],
    skippedLargeFiles: [],
    errors: [],
  };

  for (const operation of operations) {
    try {
      const absolutePath = path.isAbsolute(operation.path)
        ? operation.path
        : path.resolve(cwd, operation.path);

      // Skip bash tool files
      if (operation.source === 'bash') {
        result.skippedBashFiles.push(operation.path);
        continue;
      }

      // Skip if file is too large
      if (!shouldTrackFile(absolutePath, maxFileSize)) {
        result.skippedLargeFiles.push(operation.path);
        continue;
      }

      // Revert operation (inverse logic)
      switch (operation.type) {
        case 'create':
          // Undo create = delete the file
          if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            result.restoredFiles.push(operation.path);
          }
          break;

        case 'modify':
          // Undo modify = no-op (will be restored by parent operations)
          // We don't need to do anything here because the parent's state
          // will be applied by restoreFilesFromOperations
          break;

        case 'delete':
          // Undo delete = restore the file with old content
          if (operation.content !== undefined) {
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(absolutePath, operation.content, 'utf-8');
            result.restoredFiles.push(operation.path);
          }
          break;
      }
    } catch (error) {
      result.success = false;
      result.errors.push({
        file: operation.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * Build restore operations for snapshot rollback
 * Returns operations to restore to the state BEFORE target snapshot
 */
export function buildRestoreOperations(
  snapshots: FileSnapshot[],
  targetMessageUuid: string,
  messages?: any[], // Message list to resolve parent relationships
): FileOperation[] {
  const snapshotMap = new Map<string, FileSnapshot>();
  for (const snapshot of snapshots) {
    snapshotMap.set(snapshot.messageUuid, snapshot);
  }

  const targetSnapshot = snapshotMap.get(targetMessageUuid);
  if (!targetSnapshot) {
    return [];
  }

  const targetTime = new Date(targetSnapshot.timestamp).getTime();

  // Step 1: Build parent state (state before target snapshot)
  const parentOperations = buildSnapshotPath(
    snapshots,
    targetMessageUuid,
    messages,
  );
  const parentFiles = new Set(parentOperations.map((op) => op.path));

  // Special handling: If parent state is empty (first snapshot case)
  const isFirstSnapshot = parentOperations.length === 0;

  let restoreOperations: FileOperation[];

  if (isFirstSnapshot) {
    // For the first snapshot, we restore based on the snapshot's operations themselves
    restoreOperations = [];

    for (const op of targetSnapshot.operations) {
      if (op.type === 'create') {
        // Created file should be deleted when rolling back
        restoreOperations.push({
          type: 'delete',
          path: op.path,
          source: 'write',
        });
      } else if (op.type === 'modify') {
        // Modified file should be restored to before content
        restoreOperations.push({
          type: 'create', // Use create to restore the before content
          path: op.path,
          content: op.content, // This is the BEFORE content
          source: op.source,
        });
      } else if (op.type === 'delete') {
        // Deleted file should be restored
        if (op.content) {
          restoreOperations.push({
            type: 'create',
            path: op.path,
            content: op.content, // beforeContent
            source: op.source,
          });
        }
      }
    }
  } else {
    // Normal case: restore to parent state and clean up files created after
    const filesToDelete = new Set<string>();
    for (const snapshot of snapshots) {
      const snapshotTime = new Date(snapshot.timestamp).getTime();

      if (snapshotTime >= targetTime) {
        for (const op of snapshot.operations) {
          // Track files that appear in target or later (create/modify)
          // We'll delete them if they don't exist in parent state
          if (
            (op.type === 'create' || op.type === 'modify') &&
            !parentFiles.has(op.path)
          ) {
            filesToDelete.add(op.path);
          }
        }
      }
    }

    // Step 3: Combine parent operations + delete operations
    restoreOperations = [...parentOperations];

    // Add delete operations for files created after parent
    for (const filePath of filesToDelete) {
      restoreOperations.push({
        type: 'delete',
        path: filePath,
        source: 'write',
      });
    }
  }

  return restoreOperations;
}

/**
 * Build snapshot path from message tree
 * Returns operations in order from root to target's PARENT (excluding target)
 * This restores to the state BEFORE the target snapshot was applied
 */
export function buildSnapshotPath(
  snapshots: FileSnapshot[],
  targetMessageUuid: string,
  messages?: any[], // Message list to resolve parent relationships
): FileOperation[] {
  const snapshotMap = new Map<string, FileSnapshot>();
  for (const snapshot of snapshots) {
    snapshotMap.set(snapshot.messageUuid, snapshot);
  }

  const targetSnapshot = snapshotMap.get(targetMessageUuid);
  if (!targetSnapshot) {
    return [];
  }

  // If target itself has no parent, restore to empty state (project initial state)
  if (targetSnapshot.parentMessageUuid === null) {
    return [];
  }

  // Find the parent snapshot by walking up the message tree
  // The parent message might not have a snapshot (e.g., tool messages, user messages)
  // So we need to find the nearest ancestor message that has a snapshot
  let parentSnapshot: FileSnapshot | undefined;

  if (messages) {
    const messageMap = new Map(messages.map((m: any) => [m.uuid, m]));
    let currentMessageUuid = targetSnapshot.parentMessageUuid;

    while (currentMessageUuid) {
      const snapshot = snapshotMap.get(currentMessageUuid);
      if (snapshot) {
        parentSnapshot = snapshot;
        break;
      }

      // Move to parent message
      const message = messageMap.get(currentMessageUuid);
      if (!message) {
        break;
      }
      currentMessageUuid = message.parentUuid || message.parentMessageUuid;
      if (!currentMessageUuid) {
        break;
      }
    }
  } else {
    // Fallback: try direct lookup (old behavior)
    parentSnapshot = snapshots.find(
      (s) => s.messageUuid === targetSnapshot.parentMessageUuid,
    );
  }

  // If no parent snapshot found, it means we're restoring to before the first snapshot
  // In this case, return empty array to indicate "restore to project initial state"
  if (!parentSnapshot) {
    return [];
  }

  // Walk backward from parent to root
  const path: FileSnapshot[] = [];
  let current: FileSnapshot | undefined = parentSnapshot;

  while (current) {
    path.unshift(current);

    // Stop if we reached the root (null parent)
    if (current.parentMessageUuid === null) {
      break;
    }

    // Find next parent snapshot using message tree if available
    let nextParent: FileSnapshot | undefined;
    if (messages) {
      const messageMap = new Map(messages.map((m: any) => [m.uuid, m]));
      let parentMessageUuid = current.parentMessageUuid;

      // Walk up the message tree to find the next snapshot
      while (parentMessageUuid) {
        const snapshot = snapshotMap.get(parentMessageUuid);
        if (snapshot) {
          nextParent = snapshot;
          break;
        }

        const message = messageMap.get(parentMessageUuid);
        if (!message) {
          break;
        }
        parentMessageUuid = message.parentUuid || message.parentMessageUuid;
        if (!parentMessageUuid) {
          break;
        }
      }
    } else {
      nextParent = snapshots.find(
        (s) => s.messageUuid === current!.parentMessageUuid,
      );
    }

    // Move to next parent
    current = nextParent;

    // If no more parents found, we've reached the oldest snapshot in the chain
    if (!current) {
      break;
    }
  }

  // Merge operations, keeping final state for each file
  const finalOperations = new Map<string, FileOperation>();

  for (const snapshot of path) {
    for (const operation of snapshot.operations) {
      const key = operation.path;

      // Handle operation merging
      const existing = finalOperations.get(key);
      if (existing) {
        // create + delete = file doesn't exist
        if (existing.type === 'create' && operation.type === 'delete') {
          finalOperations.delete(key);
          continue;
        }
        // modify + delete = file doesn't exist
        if (existing.type === 'modify' && operation.type === 'delete') {
          finalOperations.delete(key);
          continue;
        }
        // delete + create = file exists with new content
        // delete + modify = file exists with new content
        // Just keep the latest operation (create/modify will override delete)
      }

      // Keep latest operation
      finalOperations.set(key, operation);
    }
  }

  return Array.from(finalOperations.values());
}

/**
 * Clean old snapshots using FIFO strategy
 */
export function cleanOldSnapshots(
  snapshots: FileSnapshot[],
  maxSnapshots: number,
): FileSnapshot[] {
  if (snapshots.length <= maxSnapshots) {
    return snapshots;
  }

  // Sort by timestamp and keep the most recent ones
  return snapshots
    .sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )
    .slice(0, maxSnapshots);
}
