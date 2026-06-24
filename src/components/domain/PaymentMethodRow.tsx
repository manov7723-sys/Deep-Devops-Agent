/**
 * Brand mark + masked PAN + expiry.
 */
export interface PaymentMethodRowProps {
  brand: string;
  last4: string;
  exp: string;
}

export function PaymentMethodRow({ brand, last4, exp }: PaymentMethodRowProps) {
  return (
    <div className="row gap-3">
      <span className="row center dda-card-brand" aria-hidden>
        {brand.toUpperCase()}
      </span>
      <div className="col" style={{ lineHeight: 1.3 }}>
        <span style={{ fontWeight: 600 }}>•••• •••• •••• {last4}</span>
        <span className="faint" style={{ fontSize: 12 }}>
          Expires {exp}
        </span>
      </div>
    </div>
  );
}
