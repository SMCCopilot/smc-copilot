import { AuthGate } from '@/components/auth-gate';
import { Shell } from '@/components/shell';

export default function Page() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}
