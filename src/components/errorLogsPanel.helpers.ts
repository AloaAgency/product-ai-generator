import type { ErrorLog } from '@/lib/types'
import { getSafeErrorContext, getSafeErrorMessage } from './errorDisplay.helpers'

export const ERROR_LOGS_PAGE_SIZE = 20

export interface VisibleErrorLog extends ErrorLog {
  safeMessage: string
  safeContext: string | null
}

export const getVisibleErrorLogs = (errorLogs: ErrorLog[], visibleCount: number): VisibleErrorLog[] =>
  errorLogs.slice(0, visibleCount).map((log) => ({
    ...log,
    safeMessage: getSafeErrorMessage(log.error_message),
    safeContext: getSafeErrorContext(log.error_context),
  }))

export const hasMoreErrorLogs = (visibleCount: number, totalCount: number) => visibleCount < totalCount

export const getRemainingErrorLogCount = (visibleCount: number, totalCount: number) =>
  Math.max(0, totalCount - visibleCount)

export const getNextVisibleErrorLogCount = (
  visibleCount: number,
  totalCount: number,
  pageSize = ERROR_LOGS_PAGE_SIZE
) => Math.min(totalCount, visibleCount + pageSize)

export const shouldShowErrorLogsPanel = (errorLogCount: number, loadingErrorLogs: boolean) =>
  errorLogCount > 0 || loadingErrorLogs
