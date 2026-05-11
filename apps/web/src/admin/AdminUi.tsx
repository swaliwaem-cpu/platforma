import type { ComponentProps, ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';

type AdminButtonTone = 'primary' | 'secondary' | 'success' | 'danger' | 'text';

const buttonVariantByTone: Record<AdminButtonTone, ComponentProps<typeof Button>['variant']> = {
  primary: 'default',
  secondary: 'outline',
  success: 'secondary',
  danger: 'destructive',
  text: 'ghost',
};

export function AdminButton({
  className,
  fit = true,
  tone = 'secondary',
  variant,
  ...props
}: ComponentProps<typeof Button> & {
  fit?: boolean;
  tone?: AdminButtonTone;
}) {
  return (
    <Button
      className={cn('admin-button', `admin-button--${tone}`, fit && 'admin-button--fit', className)}
      variant={variant ?? buttonVariantByTone[tone]}
      {...props}
    />
  );
}

export function AdminPanel({ className, ...props }: ComponentProps<typeof Card>) {
  return <Card className={cn('admin-panel', className)} {...props} />;
}

export function AdminStatusBadge({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge className={cn('status-pill', className)} variant="secondary">
      {children}
    </Badge>
  );
}

export function AdminAlert({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'error' | 'notice';
}) {
  return (
    <Alert className={cn('admin-alert', `admin-alert--${tone}`)} variant={tone === 'error' ? 'destructive' : 'default'}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function AdminEmptyState({
  description,
  title,
}: {
  description?: string;
  title: string;
}) {
  return (
    <Empty className="admin-empty-state">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
