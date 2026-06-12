import { type ReactNode } from 'react'
import { cn } from '@shared/utils'

interface CardProps { children: ReactNode; className?: string; padding?: 'none' | 'sm' | 'md' | 'lg'; onClick?: () => void }
export function Card({ children, className, padding = 'md', onClick }: CardProps) {
  const p = { none: '', sm: 'p-3', md: 'p-5', lg: 'p-6' }
  return <div onClick={onClick} className={cn('bg-white rounded-xl border border-slate-200 shadow-sm', p[padding], className)}>{children}</div>
}

interface CardHeaderProps { children: ReactNode; className?: string }
export function CardHeader({ children, className }: CardHeaderProps) {
  return <div className={cn('flex flex-col space-y-1.5', className)}>{children}</div>
}

interface CardTitleProps { children: ReactNode; className?: string }
export function CardTitle({ children, className }: CardTitleProps) {
  return <h3 className={cn('font-semibold leading-none tracking-tight', className)}>{children}</h3>
}

interface CardContentProps { children: ReactNode; className?: string }
export function CardContent({ children, className }: CardContentProps) {
  return <div className={cn('', className)}>{children}</div>
}

interface StatCardProps {
  label: string; value: string | number; change?: string
  changeType?: 'positive' | 'negative' | 'neutral'; icon?: ReactNode; iconColor?: string
}
export function StatCard({ label, value, change, changeType = 'neutral', icon, iconColor = 'bg-blue-100 text-blue-600' }: StatCardProps) {
  const cc = { positive: 'text-emerald-600', negative: 'text-red-500', neutral: 'text-slate-500' }
  return (
    <Card className="flex items-start gap-4">
      {icon && <div className={cn('p-2.5 rounded-lg flex-shrink-0', iconColor)}>{icon}</div>}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-500 font-medium">{label}</p>
        <p className="text-2xl font-semibold text-slate-900 mt-0.5">{value}</p>
        {change && <p className={cn('text-xs mt-1', cc[changeType])}>{change}</p>}
      </div>
    </Card>
  )
}
