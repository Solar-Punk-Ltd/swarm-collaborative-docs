import { Logger } from './logger'

export class ErrorHandler {
  private static instance: ErrorHandler
  private logger = Logger.getInstance()

  private constructor() {}

  public static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler()
    }

    return ErrorHandler.instance
  }

  handleError(error: unknown, context?: string): void {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
    const stackTrace = error instanceof Error ? error.stack : null

    this.logger.error(`Error in ${context || 'unknown context'}: ${errorMessage}`, {
      stack: stackTrace,
    })
  }
}
