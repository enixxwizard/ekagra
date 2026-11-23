import React from 'react';

interface BiIconProps {
  name: string;
  className?: string;
  spin?: boolean;
  title?: string;
}

/**
 * Consistent Bootstrap Icons wrapper guaranteeing crisp vertical alignment and sizing
 * without baseline drift across buttons, menus, tabs, and badges.
 */
export const BiIcon: React.FC<BiIconProps> = ({
  name,
  className = '',
  spin = false,
  title,
}) => (
  <i
    className={`bi bi-${name} inline-flex items-center justify-center shrink-0 leading-none ${
      spin ? 'animate-spin' : ''
    } ${className}`}
    aria-hidden="true"
    title={title}
  />
);
