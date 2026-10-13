import { Eye, EyeOff } from 'lucide-react'
import { useId, useState, type ComponentProps } from 'react'

interface PasswordFieldProps extends Omit<ComponentProps<'input'>, 'type' | 'id'> { label: string }

export function PasswordField({ label, ...props }: PasswordFieldProps) {
  const id = useId()
  const [visible, setVisible] = useState(false)
  return <div className="account-field">
    <label htmlFor={id}>{label}</label>
    <div className="account-password">
      <input {...props} id={id} type={visible ? 'text' : 'password'} />
      <button type="button" className="icon-button" disabled={props.disabled} aria-label={`${visible ? '隐藏' : '显示'}${label}`} aria-controls={id} aria-pressed={visible} onClick={() => setVisible(value => !value)}>
        {visible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
      </button>
    </div>
  </div>
}

export function FormNotice({ error, message }: { error?: string; message?: string }) {
  return error ? <p className="account-notice is-error" role="alert">{error}</p> : message ? <p className="account-notice is-success" role="status">{message}</p> : null
}
