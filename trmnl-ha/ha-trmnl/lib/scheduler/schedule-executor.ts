/**
 * Schedule Executor - Orchestrates scheduled screenshot capture
 *
 * Uses stateless services for screenshot operations.
 *
 * @module lib/scheduler/schedule-executor
 */

import {
  saveScreenshot,
  cleanupOldScreenshots,
  uploadToWebhook,
  buildParams,
} from './services.js'
import {
  SCHEDULER_MAX_RETRIES,
  SCHEDULER_RETRY_DELAY_MS,
  SCHEDULER_RETENTION_MULTIPLIER,
  SCHEDULER_IMAGE_FILE_PATTERN,
  isSchedulerNetworkError,
} from '../../const.js'
import { loadSchedules } from '../scheduleStore.js'
import type { Schedule, ScreenshotParams } from '../../types/domain.js'
import { schedulerLogger } from '../logger.js'

const log = schedulerLogger()

/** Function type for screenshot capture */
export type ScreenshotFunction = (params: ScreenshotParams) => Promise<Buffer>

/** Result from schedule execution */
export interface ExecutionResult {
  success: boolean
  savedPath: string
}

/**
 * Orchestrates schedule execution with retry logic.
 */
export class ScheduleExecutor {
  #screenshotFn: ScreenshotFunction
  #outputDir: string

  constructor(screenshotFn: ScreenshotFunction, outputDir: string) {
    this.#screenshotFn = screenshotFn
    this.#outputDir = outputDir
  }

  /** Executes schedule with automatic retry on network failures */
  async call(schedule: Schedule): Promise<ExecutionResult> {
    const startTime = Date.now()
    log.info`Running: ${schedule.name}`

    const result = await this.#executeWithRetry(schedule)

    log.info`Completed: ${schedule.name} in ${Date.now() - startTime}ms`
    return result
  }

  /** Retry wrapper for network failures */
  async #executeWithRetry(schedule: Schedule): Promise<ExecutionResult> {
    for (let attempt = 1; attempt <= SCHEDULER_MAX_RETRIES; attempt++) {
      try {
        return await this.#executeOnce(schedule)
      } catch (err) {
        if (!this.#shouldRetry(err as Error, attempt)) throw err
        this.#logRetry(schedule.name, err as Error, attempt)
        await this.#delay(SCHEDULER_RETRY_DELAY_MS)
      }
    }
    throw new Error(`Failed after ${SCHEDULER_MAX_RETRIES} attempts`)
  }

  /** Single execution attempt */
  async #executeOnce(schedule: Schedule): Promise<ExecutionResult> {
    const params = buildParams(schedule)
    const imageBuffer = await this.#screenshotFn(params)
    const savedPath = await this.#saveAndCleanup(schedule, imageBuffer, params.format)
    await this.#uploadIfConfigured(schedule, imageBuffer, params.format)
    return { success: true, savedPath }
  }

  /** Saves screenshot and runs LRU cleanup */
  async #saveAndCleanup(schedule: Schedule, imageBuffer: Buffer, format: string): Promise<string> {
    const { outputPath } = saveScreenshot({
      outputDir: this.#outputDir,
      scheduleName: schedule.name,
      imageBuffer,
      format: format as 'png' | 'jpeg' | 'bmp',
    })
    log.info`Saved: ${outputPath}`

    const schedules = await loadSchedules()
    const maxFiles = schedules.filter((s) => s.enabled).length * SCHEDULER_RETENTION_MULTIPLIER
    const { deletedCount } = cleanupOldScreenshots({
      outputDir: this.#outputDir,
      maxFiles,
      filePattern: SCHEDULER_IMAGE_FILE_PATTERN,
    })

    if (deletedCount > 0) log.debug`Cleanup: Deleted ${deletedCount} old file(s)`
    return outputPath
  }

  /** Uploads to webhook if configured */
  async #uploadIfConfigured(schedule: Schedule, imageBuffer: Buffer, format: string): Promise<void> {
    if (!schedule.webhook_url) return

    try {
      await uploadToWebhook({
        webhookUrl: schedule.webhook_url,
        webhookHeaders: schedule.webhook_headers,
        imageBuffer,
        format: format as 'png' | 'jpeg' | 'bmp',
      })
    } catch (err) {
      // Error already logged by uploadToWebhook, just re-log for schedule context
      log.error`Schedule "${schedule.name}" webhook failed: ${(err as Error).message}`
    }
  }

  #shouldRetry(error: Error, attempt: number): boolean {
    return isSchedulerNetworkError(error) && attempt < SCHEDULER_MAX_RETRIES
  }

  #logRetry(name: string, err: Error, attempt: number): void {
    log.warn`Network error (${attempt}/${SCHEDULER_MAX_RETRIES}) for ${name}: ${err.message}`
    log.info`Retrying in ${SCHEDULER_RETRY_DELAY_MS / 1000}s...`
  }

  #delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
