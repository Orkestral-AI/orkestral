import { registerHandler } from '../register';
import { UserRepository } from '../../db/repositories/user.repo';

export function registerUserHandlers(): void {
  const repo = new UserRepository();

  registerHandler('user:get', () => repo.get());
  registerHandler('user:update', (req) => repo.upsert(req));
}
