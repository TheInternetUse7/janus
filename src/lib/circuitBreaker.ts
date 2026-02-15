import CircuitBreaker from 'opossum';
import { createChildLogger } from './logger';

const log = createChildLogger('circuit-breaker');

const FAILURE_THRESHOLD = parseInt(process.env.CB_FAILURE_THRESHOLD || '10', 10);
const RESET_TIMEOUT = parseInt(process.env.CB_RESET_TIMEOUT || '60000', 10);

const breakers = new Map<string, CircuitBreaker>();

/**
 * Create or get a circuit breaker for a specific service.
 * Uses the `opossum` library.
 * 
 * If the service returns 5xx errors > threshold times in the window,
 * the circuit "opens" and all requests are paused for resetTimeout ms.
 */
export function getCircuitBreaker<T>(
  name: string,
  action: (...args: any[]) => Promise<T>
): CircuitBreaker<any[], T> {
  if (!breakers.has(name)) {
    const breaker = new CircuitBreaker(action, {
      timeout: 15000, // 15s timeout per request
      errorThresholdPercentage: 50,
      volumeThreshold: FAILURE_THRESHOLD,
      resetTimeout: RESET_TIMEOUT,
      rollingCountTimeout: 60000, // 1 minute rolling window
    });

    breaker.on('open', () => {
      log.warn({ service: name }, 'Circuit OPENED - service appears down');
    });

    breaker.on('halfOpen', () => {
      log.info({ service: name }, 'Circuit HALF-OPEN - testing service');
    });

    breaker.on('close', () => {
      log.info({ service: name }, 'Circuit CLOSED - service recovered');
    });

    breaker.on('fallback', () => {
      log.debug({ service: name }, 'Circuit breaker fallback triggered');
    });

    breakers.set(name, breaker);
  }

  return breakers.get(name)! as CircuitBreaker<any[], T>;
}

/**
 * Check if a circuit is currently open (service is down).
 */
export function isCircuitOpen(name: string): boolean {
  const breaker = breakers.get(name);
  if (!breaker) return false;
  return breaker.opened;
}

/**
 * Shutdown all circuit breakers.
 */
export function shutdownBreakers(): void {
  for (const [name, breaker] of breakers) {
    breaker.shutdown();
    log.debug({ service: name }, 'Circuit breaker shut down');
  }
  breakers.clear();
}
