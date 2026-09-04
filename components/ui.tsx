'use client'

/**
 * v4-launchpad design-system primitives, ported to the pumpfun Solana
 * client. Exactly two colors (ink #101010 / paper #F2EFE7), square
 * corners, hard zero-blur shadows, uppercase Courier New labels. Pure
 * text, no images, no gradients, no rounded corners. Class names and
 * wording are identical to the v4 port; only the two viem-coupled
 * helpers were adapted: shortAddress (reused from lib/format, which
 * roster.tsx re-exports) and ExplorerLink (Solana explorer URLs).
 */
import type {
    ButtonHTMLAttributes,
    InputHTMLAttributes,
    ReactNode,
    SelectHTMLAttributes,
} from 'react'
import { shortAddress } from '../lib/format'

/* ---------- labels: mono caps, the mechanical voice ---------- */

export function Label({ children }: { children: ReactNode }) {
    return <span className="label-mono block">{children}</span>
}

/* ---------- inputs: paper wells ---------- */

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input {...props} className={`input-brutal ${props.className ?? ''}`} />
    )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            {...props}
            className={`input-brutal ${props.className ?? ''}`}
        />
    )
}

export function Field({
    label,
    aside,
    children,
}: {
    label: string
    aside?: ReactNode
    children: ReactNode
}) {
    return (
        <div>
            <div className="flex w-full justify-between gap-2">
                <Label>{label}</Label>
                {aside ? (
                    <span className="label-mono block opacity-60 truncate">
                        {aside}
                    </span>
                ) : null}
            </div>
            <div className="mt-1">{children}</div>
        </div>
    )
}

/* ---------- buttons: ink plates ---------- */

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    /** Inverted face (paper bg, ink text). */
    invert?: boolean
    /** Pressed/persistent variant for toggle groups. */
    pressed?: boolean
    /** Done acknowledgment, shows for 1.5s: "DONE ✓". */
    done?: boolean
    doneText?: string
}

export function Btn({
    invert,
    pressed,
    done,
    doneText = 'DONE',
    className = '',
    children,
    ...rest
}: BtnProps) {
    const cls = [
        'btn-brutal',
        invert ? 'btn-brutal-invert' : '',
        pressed ? 'btn-brutal-pressed' : '',
        done ? 'btn-brutal-done' : '',
        className,
    ]
        .filter(Boolean)
        .join(' ')
    return (
        <button {...rest} className={cls}>
            {done ? `${doneText} ✓` : children}
        </button>
    )
}

/* ---------- cards ---------- */

export function Card({
    head,
    foot,
    inverted,
    children,
    className = '',
}: {
    head?: ReactNode
    foot?: ReactNode
    inverted?: boolean
    children: ReactNode
    className?: string
}) {
    return (
        <section
            className={`${inverted ? 'card-brutal-inverted' : 'card-brutal'} ${className}`}>
            {head ? <div className="card-head">{head}</div> : null}
            {children ? <div className="card-body">{children}</div> : null}
            {foot ? <div className="card-foot">{foot}</div> : null}
        </section>
    )
}

/* ---------- status line: mono meta ---------- */

export function StatusLine({
    text,
    tone = 'idle',
}: {
    text: string
    tone?: 'idle' | 'error' | 'ok'
}) {
    // Two-color rule: tones differ only by inversion or weight, never hue.
    const cls =
        tone === 'error'
            ? 'text-ink font-bold'
            : tone === 'ok'
              ? 'font-bold'
              : 'opacity-70'
    return <p className={`label-mono text-[11px] break-all ${cls}`}>{text}</p>
}

/* ---------- explorer links (Solana) ---------- */

export function ExplorerLink({
    hash,
    kind = 'tx',
    cluster = 'devnet',
    inverted,
}: {
    hash: string
    kind?: 'tx' | 'address'
    /** Solana explorer cluster; devnet is this app's network. */
    cluster?: 'mainnet' | 'devnet'
    /** For links sitting on an ink card (error toasts): invert the hover. */
    inverted?: boolean
}) {
    const href = `https://explorer.solana.com/${kind}/${hash}${
        cluster === 'devnet' ? '?cluster=devnet' : ''
    }`
    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`underline underline-offset-2 ${
                inverted
                    ? 'hover:bg-paper hover:text-ink'
                    : 'hover:bg-ink hover:text-paper'
            }`}>
            {shortAddress(hash)}
        </a>
    )
}

/* ---------- collapsible section ---------- */

export function Collapse({
    open,
    onToggle,
    label,
    children,
}: {
    open: boolean
    onToggle: () => void
    label: string
    children: ReactNode
}) {
    return (
        <div>
            <Btn
                type="button"
                invert
                pressed={open}
                onClick={onToggle}
                className="w-full justify-center !text-[11px]">
                {open ? '−' : '+'} {label}
            </Btn>
            {open ? (
                <div className="mt-3 flex flex-col gap-3">{children}</div>
            ) : null}
        </div>
    )
}
