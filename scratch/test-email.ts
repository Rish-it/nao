import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: '.env' });

async function testEmail() {
	const { SMTP_HOST, SMTP_PORT, SMTP_MAIL_FROM, SMTP_PASSWORD, SMTP_SSL } = process.env;

	console.log('Using credentials:', { SMTP_HOST, SMTP_PORT, SMTP_MAIL_FROM, SMTP_SSL });

	const transporter = nodemailer.createTransport({
		host: SMTP_HOST,
		port: Number(SMTP_PORT) || 587,
		secure: SMTP_SSL === 'true',
		auth: {
			user: SMTP_MAIL_FROM,
			pass: SMTP_PASSWORD,
		},
	});

	try {
		const info = await transporter.sendMail({
			from: SMTP_MAIL_FROM,
			to: SMTP_MAIL_FROM,
			subject: 'Test Email from Script',
			text: 'This is a test.',
		});
		console.log('Email sent! Message ID:', info.messageId);
		console.log('Preview URL:', nodemailer.getTestMessageUrl(info));
	} catch (error) {
		console.error('Error sending test email:', error);
	}
}

testEmail();
