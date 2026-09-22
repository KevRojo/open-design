import { basename } from 'node:path';

import { BaseSequencer, type TestSpecification } from 'vitest/node';

const PARTITION_COUNT = 4;
const PARTITION_PATTERN = /^od-next-automatic-simple-server-partition-(\d+)\.test\.ts$/;

export class DaemonTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (shard.count !== PARTITION_COUNT) {
      return super.shard(files);
    }

    const partitions = new Map<number, TestSpecification>();
    const ordinaryFiles: TestSpecification[] = [];
    for (const file of files) {
      const match = PARTITION_PATTERN.exec(basename(file.moduleId));
      if (!match) {
        ordinaryFiles.push(file);
        continue;
      }

      const partition = Number(match[1]);
      if (partition < 1 || partition > PARTITION_COUNT || partitions.has(partition)) {
        throw new Error(`Invalid OD Next server partition entry: ${file.moduleId}`);
      }
      partitions.set(partition, file);
    }

    if (partitions.size !== PARTITION_COUNT) {
      throw new Error(
        `Expected ${PARTITION_COUNT} OD Next server partition entries, found ${partitions.size}`,
      );
    }

    const ordinaryShard = await super.shard(ordinaryFiles);
    return [...ordinaryShard, partitions.get(shard.index)!];
  }
}
