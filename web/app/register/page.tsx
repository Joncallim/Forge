import { RegisterForm } from './RegisterForm'
import { passkeysEnabled } from '@/lib/auth-options'

export default function RegisterPage() {
  return <RegisterForm passkeysEnabled={passkeysEnabled()} />
}
