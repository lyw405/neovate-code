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

    // Convert to relative path for storage to avoid path issues when cwd changes
    const relativePath = path.relative(this.cwd, absolutePath);

    // Store with relative path to ensure portability
    this.operations.set(absolutePath, {
      ...operation,
      path: relativePath,
    });
  }

  /**
   * Collect file snapshot from tool execution result
   * This is the main entry point for collecting snapshots
   */
  async collectFromToolResult(
    toolUse: { name: string; params: Record<string, any> },
    toolResult: { _rawParams?: Record<string, any>; _affectedFiles?: string[] },
  ): Promise<void> {
    try {
      if (toolUse.name === 'write' || toolUse.name === 'edit') {
        await this.collectFromFileModificationTool(toolUse, toolResult);
      } else if (toolUse.name === 'bash') {
        await this.collectFromBashTool(toolResult);
      }
    } catch (error) {
      console.error('Failed to collect snapshot:', error);
    }
  }

  /**
   * Collect snapshot from write/edit tool
   */
  private async collectFromFileModificationTool(
    toolUse: { name: string; params: Record<string, any> },
    toolResult: { _rawParams?: Record<string, any> },
  ): Promise<void> {
    const filePath = toolUse.params.file_path;
    if (!filePath || typeof filePath !== 'string') {
      return;
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath);

    // Get beforeContent from toolResult._rawParams (set by tool.invoke)
    const beforeContent = toolResult._rawParams?._beforeContent as
      | string
      | undefined;
    const beforeExists = beforeContent !== undefined;

    const fileExists = fs.existsSync(absolutePath);
    const afterContent = fileExists
      ? fs.readFileSync(absolutePath, 'utf-8')
      : undefined;

    // Determine operation type based on before/after state
    if (beforeExists && !fileExists) {
      // File was deleted
      this.addOperation({
        type: 'delete',
        path: filePath,
        source: toolUse.name as 'write' | 'edit',
        content: beforeContent,
      });
    } else {
      // File was created or modified
      this.addOperation({
        type: beforeExists ? 'modify' : 'create',
        path: filePath,
        source: toolUse.name as 'write' | 'edit',
        // For modify: store BEFORE content in 'content' and AFTER content in 'afterContent'
        // For create: store AFTER content in 'content'
        content: beforeExists ? beforeContent : afterContent,
        afterContent: beforeExists ? afterContent : undefined,
      });
    }
  }

  /**
   * Collect snapshot from bash tool
   * Note: bash only records AFTER state, cannot be fully reverted
   */
  private async collectFromBashTool(toolResult: {
    _affectedFiles?: string[];
  }): Promise<void> {
    const bashFiles = toolResult._affectedFiles;
    if (!bashFiles || !Array.isArray(bashFiles)) {
      return;
    }

    for (const filePath of bashFiles) {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(this.cwd, filePath);

      if (fs.existsSync(absolutePath)) {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        this.addOperation({
          type: 'create',
          path: filePath,
          source: 'bash',
          content,
        });
      }
    }
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

  // Phase 1: Pre-check and filter operations
  const operationsToExecute: Array<{
    operation: FileOperation;
    absolutePath: string;
  }> = [];

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

      // Pre-check: Verify operation is feasible
      if (operation.type === 'create' || operation.type === 'modify') {
        const dir = path.dirname(absolutePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        // Check write permission
        try {
          fs.accessSync(dir, fs.constants.W_OK);
        } catch (permError) {
          result.success = false;
          result.errors.push({
            file: operation.path,
            error: `No write permission for directory: ${dir}`,
          });
          continue;
        }
      }

      operationsToExecute.push({ operation, absolutePath });
    } catch (error) {
      result.success = false;
      result.errors.push({
        file: operation.path,
        error: `Pre-check failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // If pre-check failed, return immediately
  if (!result.success) {
    return result;
  }

  // Phase 2: Execute operations
  for (const { operation, absolutePath } of operationsToExecute) {
    try {
      // Apply operation
      // CRITICAL: Operations from buildRestoreOperations/buildSnapshotPath represent
      // the CUMULATIVE state we want to restore to.
      // - For 'create': content = the final state after creation
      // - For 'modify': afterContent = the final state after all modifications
      // - For 'delete': delete the file
      switch (operation.type) {
        case 'create':
          // Create/overwrite file with the create content
          if (operation.content !== undefined) {
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(absolutePath, operation.content, 'utf-8');
            result.restoredFiles.push(operation.path);
          }
          break;

        case 'modify':
          // For modify: we want the FINAL state which is in afterContent
          // (The cumulative result of all modifications up to this point)
          if (operation.afterContent !== undefined) {
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(absolutePath, operation.afterContent, 'utf-8');
            result.restoredFiles.push(operation.path);
          } else if (operation.content !== undefined) {
            // Fallback: if no afterContent, use content
            const dir = path.dirname(absolutePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(absolutePath, operation.content, 'utf-8');
            result.restoredFiles.push(operation.path);
          }
          break;

        case 'delete':
          if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
            result.restoredFiles.push(operation.path);

            // Clean up empty parent directories
            const dir = path.dirname(absolutePath);
            try {
              if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
                fs.rmdirSync(dir);
              }
            } catch {
              // Ignore directory cleanup errors
            }
          }
          break;
      }
    } catch (error) {
      // CRITICAL: If any operation fails, mark as failed and stop immediately
      // Don't continue with remaining operations to avoid inconsistent state
      result.success = false;
      result.errors.push({
        file: operation.path,
        error: error instanceof Error ? error.message : String(error),
      });
      // Stop processing immediately on first error
      break;
    }
  }

  return result;
}

/**
 * Build restore operations for snapshot rollback
 * Returns operations to restore to the state BEFORE target snapshot
 *
 * CRITICAL: Handles two cases differently:
 * 1. First snapshot (no parent): Revert the snapshot's operations
 * 2. Other snapshots: Restore to parent state + clean up files created after
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

  // CRITICAL: Determine if this is the first snapshot
  // A snapshot is "first" if:
  // 1. It has no parent (parentMessageUuid === null), OR
  // 2. No parent snapshot exists in the chain
  const isFirstSnapshot = parentOperations.length === 0;

  let restoreOperations: FileOperation[];

  if (isFirstSnapshot) {
    // === CASE 1: First Snapshot ===
    // Restore to project initial state by REVERTING the snapshot's operations
    // Example: If snapshot created file.txt, we delete it
    //          If snapshot modified file.txt from A->B, we restore to A
    //          If snapshot deleted file.txt, we restore it
    restoreOperations = [];

    for (const op of targetSnapshot.operations) {
      if (op.type === 'create') {
        // Revert create -> delete the file
        restoreOperations.push({
          type: 'delete',
          path: op.path,
          source: 'write',
        });
      } else if (op.type === 'modify') {
        // Revert modify -> restore to BEFORE content
        restoreOperations.push({
          type: 'create', // Use create to restore the before content
          path: op.path,
          content: op.content, // This is the BEFORE content
          source: op.source,
        });
      } else if (op.type === 'delete') {
        // Revert delete -> restore the file
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
    // === CASE 2: Non-first Snapshot ===
    // Restore to parent state + clean up files created after target
    // Example: Parent has file1.txt, target created file2.txt
    //          We restore file1.txt to parent state, delete file2.txt

    // Step 2.1: Find all files that were created/modified at or after target time
    const filesToDelete = new Set<string>();
    const filesInTargetOrLater = new Set<string>();

    for (const snapshot of snapshots) {
      const snapshotTime = new Date(snapshot.timestamp).getTime();

      if (snapshotTime >= targetTime) {
        for (const op of snapshot.operations) {
          // Track all files touched in target or later snapshots
          if (op.type === 'create' || op.type === 'modify') {
            filesInTargetOrLater.add(op.path);

            // If file doesn't exist in parent state, mark for deletion
            if (!parentFiles.has(op.path)) {
              filesToDelete.add(op.path);
            }
          }
        }
      }
    }

    // Step 2.2: Combine parent operations + delete operations
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

  // Create messageMap once at the beginning if messages are provided
  const messageMap = messages
    ? new Map(messages.map((m: any) => [m.uuid, m]))
    : null;

  // Find the parent snapshot by walking up the message tree
  // The parent message might not have a snapshot (e.g., tool messages, user messages)
  // So we need to find the nearest ancestor message that has a snapshot
  let parentSnapshot: FileSnapshot | undefined;

  if (messageMap) {
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

  // Reuse messageMap created above

  while (current) {
    path.unshift(current);

    // Stop if we reached the root (null parent)
    if (current.parentMessageUuid === null) {
      break;
    }

    // Find next parent snapshot using message tree if available
    let nextParent: FileSnapshot | undefined;
    if (messageMap) {
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
  // CRITICAL: Handle all operation combinations correctly
  // The goal is to build the cumulative state from root to parent
  const finalOperations = new Map<string, FileOperation>();

  for (const snapshot of path) {
    for (const operation of snapshot.operations) {
      const key = operation.path;

      const existing = finalOperations.get(key);
      if (existing) {
        // Handle operation merging based on type combinations

        if (existing.type === 'create' && operation.type === 'delete') {
          // create + delete = file doesn't exist
          finalOperations.delete(key);
          continue;
        }

        if (existing.type === 'modify' && operation.type === 'delete') {
          // modify + delete = file doesn't exist
          finalOperations.delete(key);
          continue;
        }

        if (existing.type === 'create' && operation.type === 'modify') {
          // create + modify = create with the FINAL afterContent
          // The file was created (existing.content = AFTER state of creation)
          // Then modified (operation.afterContent = final state)
          finalOperations.set(key, {
            type: 'create',
            path: operation.path,
            content: operation.afterContent, // Use the final modified state
            source: operation.source,
          });
          continue;
        }

        if (existing.type === 'modify' && operation.type === 'modify') {
          // modify + modify = modify with FIRST before and LAST after
          // First modify: A -> B (content=A, afterContent=B)
          // Second modify: B -> C (content=B, afterContent=C)
          // Result: A -> C (content=A, afterContent=C)
          finalOperations.set(key, {
            type: 'modify',
            path: operation.path,
            content: existing.content, // Keep the FIRST before content (original state)
            afterContent: operation.afterContent, // Use the LAST after content (final state)
            source: operation.source,
          });
          continue;
        }

        if (existing.type === 'delete' && operation.type === 'create') {
          // delete + create = file exists with new content
          // Treat as a create operation with the new content
          finalOperations.set(key, {
            type: 'create',
            path: operation.path,
            content: operation.content, // The new content
            source: operation.source,
          });
          continue;
        }

        if (existing.type === 'delete' && operation.type === 'modify') {
          // delete + modify = file exists with modified content
          // This is unusual but possible if file was deleted then recreated and modified
          // Treat as create with the final afterContent
          finalOperations.set(key, {
            type: 'create',
            path: operation.path,
            content: operation.afterContent, // The final modified content
            source: operation.source,
          });
          continue;
        }

        // For other combinations, keep the latest operation
        // This handles: create+create (impossible), modify+create (unusual), etc.
      }

      // Keep latest operation (or first operation if no existing)
      finalOperations.set(key, operation);
    }
  }

  return Array.from(finalOperations.values());
}

/**
 * Clean old snapshots using smart strategy
 * Preserves snapshot chain integrity by keeping snapshots from newest backwards
 * following the parent chain, rather than just by timestamp
 */
export function cleanOldSnapshots(
  snapshots: FileSnapshot[],
  maxSnapshots: number,
): FileSnapshot[] {
  if (snapshots.length <= maxSnapshots) {
    return snapshots;
  }

  // Sort by timestamp descending (newest first)
  const sorted = [...snapshots].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  // Build snapshot map for quick lookup
  const snapshotMap = new Map<string, FileSnapshot>();
  for (const snapshot of snapshots) {
    snapshotMap.set(snapshot.messageUuid, snapshot);
  }

  // Keep snapshots by following parent chain from newest
  const toKeep = new Set<string>();
  let count = 0;

  // Start from the newest snapshot and walk backwards following parent chain
  for (const snapshot of sorted) {
    if (count >= maxSnapshots) {
      break;
    }

    // Add this snapshot
    toKeep.add(snapshot.messageUuid);
    count++;

    // Also add all its ancestors to maintain chain integrity
    // (but don't count them towards the limit if already added)
    let current = snapshot;
    while (current.parentMessageUuid && count < maxSnapshots) {
      const parent = snapshotMap.get(current.parentMessageUuid);
      if (!parent) {
        break;
      }
      if (!toKeep.has(parent.messageUuid)) {
        toKeep.add(parent.messageUuid);
        count++;
      }
      current = parent;
    }
  }

  // Return snapshots that should be kept, preserving original order
  return snapshots.filter((s) => toKeep.has(s.messageUuid));
}
