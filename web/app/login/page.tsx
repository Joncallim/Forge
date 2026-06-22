import { LoginForm } from './LoginForm'
import { passkeysEnabled } from '@/lib/auth-options'

export default function LoginPage() {
  return <LoginForm passkeysEnabled={passkeysEnabled()} />
}
