import { describe, expect, it } from 'vitest'
import type { ErrorLog } from '@/lib/types'
import {
  ERROR_LOGS_PAGE_SIZE,
  getNextVisibleErrorLogCount,
  getRemainingErrorLogCount,
  getVisibleErrorLogs,
  hasMoreErrorLogs,
  shouldShowErrorLogsPanel,
} from './errorLogsPanel.helpers'

const buildErrorLog = (overrides: Partial<ErrorLog> = {}): ErrorLog => ({
  id: 'log-1',
  project_id: 'project-1',
  product_id: 'product-1',
  error_message: 'Customer-safe timeout',
  error_source: 'queue',
  error_context: null,
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

describe('errorLogsPanel.helpers', () => {
  it('builds a sanitized visible log view model and respects pagination', () => {
    const visibleLogs = getVisibleErrorLogs([
      buildErrorLog(),
      buildErrorLog({
        id: 'log-2',
        error_message: 'SQLSTATE 23505 duplicate key',
        error_context: {
          authorization: 'Bearer secret-token',
          requestUrl: 'https://example.com/file.png?token=secret',
        },
      }),
    ], 1)

    expect(visibleLogs).toHaveLength(1)
    expect(visibleLogs[0].safeMessage).toBe('Customer-safe timeout')

    const redactedLogs = getVisibleErrorLogs([
      buildErrorLog({
        id: 'log-2',
        error_message: 'SQLSTATE 23505 duplicate key',
        error_context: {
          authorization: 'Bearer secret-token',
          requestUrl: 'https://example.com/file.png?token=secret',
        },
      }),
    ], 5)

    expect(redactedLogs[0].safeMessage).toBe('Something went wrong. Try again or contact support if the issue persists.')
    expect(redactedLogs[0].safeContext).toContain('[redacted]')
    expect(redactedLogs[0].safeContext).not.toContain('secret-token')
  })

  it('caps load-more pagination at the total count and reports remaining entries safely', () => {
    expect(hasMoreErrorLogs(ERROR_LOGS_PAGE_SIZE, ERROR_LOGS_PAGE_SIZE + 3)).toBe(true)
    expect(hasMoreErrorLogs(ERROR_LOGS_PAGE_SIZE + 3, ERROR_LOGS_PAGE_SIZE + 3)).toBe(false)
    expect(getNextVisibleErrorLogCount(ERROR_LOGS_PAGE_SIZE, ERROR_LOGS_PAGE_SIZE + 3)).toBe(ERROR_LOGS_PAGE_SIZE + 3)
    expect(getRemainingErrorLogCount(ERROR_LOGS_PAGE_SIZE, ERROR_LOGS_PAGE_SIZE + 3)).toBe(3)
    expect(getRemainingErrorLogCount(ERROR_LOGS_PAGE_SIZE + 5, ERROR_LOGS_PAGE_SIZE + 3)).toBe(0)
  })

  it('shows the panel while loading even when no logs have been fetched yet', () => {
    expect(shouldShowErrorLogsPanel(0, false)).toBe(false)
    expect(shouldShowErrorLogsPanel(0, true)).toBe(true)
    expect(shouldShowErrorLogsPanel(2, false)).toBe(true)
  })
})
