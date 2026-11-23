// The MT940 converter's demo: the same day and account as the reconciliation sample
// (bench/samples/reconcile.ts), as a bank still on SWIFT MT would send it, inside SWIFT blocks.
// Its :86: fields use all three layouts the converter reads: SWIFT keywords (/EREF/, /REMI/,
// /ORDP//NAME/), the German "?" subfields (?20 EREF+, ?21 SVWZ+, ?32 name) and free text.
// Converted, it passes the Test Bench and reconciles against RECONCILE_EXPECTED with the same
// exceptions as the camt.053 sample (tests/mt940.test.ts). Everyone in it is made up.

export const MT940_SAMPLE = `{1:F01NWTRDEFFAXXX0000000000}{2:O9402315261027COBADEFFXXXX00000000002610272315N}{4:
:20:STMT20261027
:25:DE89370400440532013000
:28C:306/1
:60F:C261027EUR10000,00
:61:2610271027CR25000,00NTRFINV-2026-1187//E-0001
:86:/EREF/INV-2026-1187/ORDP//NAME/Northwind Trading GmbH/REMI/USTD//I
nvoice INV-2026-1187/
:61:2610271027CR4180,00NTRFNONREF//E-0002
:86:166?00SEPA-UEBERWEISUNG?20EREF+NOTPROVIDED?21SVWZ+Payment invoice I
NV-2?22026-1192 thank you?32Bluefin Logistics BV
:61:2610271027CR9950,00NTRFINV-2026-1195//E-0003
:86:/ORDP//NAME/Kestrel Foods SA/
:61:2610271027CR6300,00NTRFNONREF//E-0004
:86:/ORDP//NAME/Orion Retail Ltd/REMI/USTD//INV-2026-1203 + INV-2026-12
04/
:61:2610271027DR1250,00NTRFPO-7781//E-0005
:86:/BENM//NAME/Atlas Office Supply/
:61:2610271027DR3400,00NTRFNONREF//E-0006
:86:177?00SEPA-UEBERWEISUNG?20EREF+NOTPROVIDED?32Harbor Freight Lines
:61:2610271027DR35,00NCHGNONREF//E-0007
:86:Account maintenance fee, October
:62F:C261027EUR50745,00
:64:C261027EUR50745,00
-}`;
