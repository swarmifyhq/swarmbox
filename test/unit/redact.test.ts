import { describe, expect, it } from 'vitest';
import { redactBody, redactTarget, secretName } from '../../src/redact.ts';

describe('redact', () => {
  it('reads a run-together name by its ending, and leaves names that only contain a secret’s letters', () => {
    for (const n of ['dbpassword', 'DB_PWD', 'csrftoken', 'ClientSecret', 'apikey'])
      expect(secretName(n)).toBe(true);
    for (const n of ['passenger', 'bypass', 'tokenizer', 'two_signature_threshold', 'secretary'])
      expect(secretName(n)).toBe(false);
  });

  it('redacts a report server’s SOAP parameters, XML elements and attributes', () => {
    const soap =
      '<soap:Body><Render><Parameters>' +
      '<ParameterValue><Name>UserName</Name><Value>report_reader</Value></ParameterValue>' +
      '<ParameterValue><Name>Password</Name><Value>hunter2</Value></ParameterValue>' +
      '</Parameters><ns:dbPassword type="s">hunter3</ns:dbPassword><Login user="r" password="hunter4"/>' +
      '</Render></soap:Body>';
    const out = redactBody(soap, 'text/xml');
    expect(out).not.toMatch(/hunter/);
    expect(out).toContain('<Name>UserName</Name><Value>report_reader</Value>');
    expect(out).toContain('<Name>Password</Name><Value>[redacted]</Value>');
    expect(out).toContain('<ns:dbPassword type="s">[redacted]</ns:dbPassword>');
    expect(out).toContain('<Login user="r" password="[redacted]"/>');
  });

  it('redacts a name/value pair in JSON, JSON cut short, and a form with no content type', () => {
    expect(
      JSON.parse(redactBody('[{"name":"Password","value":"hunter2"},{"name":"Site","value":"North"}]')),
    ).toEqual([
      { name: 'Password', value: '[redacted]' },
      { name: 'Site', value: 'North' },
    ]);
    expect(redactBody('{"user":"ana","password":"hunter2","note":"a long note that was cu')).toBe(
      '{"user":"ana","password":"[redacted]","note":"a long note that was cu',
    );
    expect(redactBody('{"user":"ana","password":"hunt')).toBe('{"user":"ana","password":"[redacted]');
    expect(redactBody('rs:Command=Render&UserName=r&Password=hunter2')).toBe(
      'rs:Command=Render&UserName=r&Password=[redacted]',
    );
    expect(redactBody('Hello there, a=b and c')).toBe('Hello there, a=b and c');
  });

  it('reads a name/value pair whatever its keys’ case, and a validation error that echoes what it refused', () => {
    expect(
      JSON.parse(redactBody('[{"Name":"Password","Value":"hunter2"},{"NAME":"Site","VALUE":"North"}]')),
    ).toEqual([
      { Name: 'Password', Value: '[redacted]' },
      { NAME: 'Site', VALUE: 'North' },
    ]);
    // FastAPI's 422: the field is named by its loc, and the value it refused comes back as input.
    const refused = JSON.parse(
      redactBody(
        JSON.stringify({
          detail: [
            { type: 'string_too_short', loc: ['body', 'password'], msg: 'too short', input: 'hunter2' },
            { type: 'missing', loc: ['body', 'site'], msg: 'Field required', input: 'North' },
            { type: 'model_type', loc: ['body'], msg: 'bad', input: { user: 'ana', apiKey: 'hunter3' } },
          ],
        }),
      ),
    ) as { detail: { input: unknown }[] };
    expect(refused.detail.map((d) => d.input)).toEqual([
      '[redacted]',
      'North',
      { user: 'ana', apiKey: '[redacted]' },
    ]);
  });

  it('redacts a typed SOAP name, a CDATA value, and a multipart form’s secret fields', () => {
    const soap =
      '<Name xsi:type="xsd:string">Password</Name> <Value xsi:type="xsd:string">hunter2</Value>' +
      '<ns:Token><![CDATA[hunter3]]></ns:Token><Note><![CDATA[keep me]]></Note>';
    const out = redactBody(soap, 'text/xml');
    expect(out).not.toMatch(/hunter/);
    expect(out).toContain('<Value xsi:type="xsd:string">[redacted]</Value>');
    expect(out).toContain('<ns:Token>[redacted]</ns:Token>');
    expect(out).toContain('<Note><![CDATA[keep me]]></Note>');
    // A body that already holds the characters a section is set aside with is read as it is.
    expect(redactBody('<a>\uE0007\uE001</a><Password>x</Password>')).toBe(
      '<a>\uE0007\uE001</a><Password>[redacted]</Password>',
    );

    const form = [
      '--b0undary',
      'Content-Disposition: form-data; name="user"',
      '',
      'ana',
      '--b0undary',
      'Content-Disposition: form-data; name="password"',
      '',
      'hunter2',
      '--b0undary',
      'Content-Disposition: form-data; name="meta"',
      'Content-Type: application/json',
      '',
      '{"apiKey":"hunter3","site":"North"}',
      '--b0undary--',
      '',
    ].join('\r\n');
    const sent = redactBody(form, 'multipart/form-data; boundary=b0undary');
    expect(sent).not.toMatch(/hunter/);
    expect(sent).toContain('name="user"\r\n\r\nana\r\n');
    expect(sent).toContain('name="password"\r\n\r\n[redacted]\r\n--b0undary');
    expect(sent).toContain('{"apiKey":"[redacted]","site":"North"}');
    expect(sent.endsWith('--b0undary--\r\n')).toBe(true);
  });

  it('reads a megabyte built to make a pattern backtrack in well under a second', () => {
    const MB = 1024 * 1024;
    const bodies = [
      '<Name>' + ' '.repeat(MB),
      '<Name>a</Name>' + ' '.repeat(MB),
      '<'.repeat(MB),
      '<a x'.repeat(MB / 4),
      '<a><![CDATA['.repeat(MB / 12),
      '<Name>Password</Name><Value><![CDATA['.repeat(MB / 37),
      '"a"' + ' '.repeat(MB),
      '{"password":"' + 'a'.repeat(MB),
    ];
    for (const body of bodies) {
      const started = performance.now();
      redactBody(body, 'text/xml');
      expect(performance.now() - started, body.slice(0, 40)).toBeLessThan(1000);
    }
  });

  it('redacts a request’s query and leaves a word that is not a path alone', () => {
    expect(redactTarget('/ReportServer?rs:Command=Render&pwd=hunter2&id=4')).toBe(
      '/ReportServer?rs%3ACommand=Render&pwd=[redacted]&id=4',
    );
    expect(redactTarget('http://north.sample.test/hook?token=abc')).toBe(
      'http://north.sample.test/hook?token=[redacted]',
    );
    expect(redactTarget('mailbox')).toBe('mailbox');
  });
});
