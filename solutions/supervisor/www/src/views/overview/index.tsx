import usehookData from './hook'
import moment from 'moment'

function Home() {
	const {timeObj, channels, selectedChannel, switchChannel, connectionState} = usehookData()
	
	// Get current channel info
	const currentChannel = channels.find(ch => ch.id === selectedChannel)
	
	// Connection state labels
	const connectionStateLabels = {
		0: 'Connecting...',
		1: 'Connected',
		2: 'Disconnecting...',
		3: 'Disconnected'
	}
	
	return (
		<div className='m-auto p-16' style={{ maxWidth: '600px' }}>
			{/* Channel Selector */}
			<div className='mb-16'>
				<div className='mb-8 text-17 font-bold'>Video Channel</div>
				<div className='flex gap-8 mb-12'>
					{channels.map(channel => (
						<button
							key={channel.id}
							onClick={() => switchChannel(channel.id)}
							className={`flex-1 py-12 px-16 rounded-8 border-2 transition-all ${
								selectedChannel === channel.id
									? 'border-blue-500 bg-blue-50 text-blue-700'
									: 'border-gray-300 bg-white text-gray-700 hover:border-blue-300'
							}`}
						>
							<div className='font-bold text-15'>CH{channel.id}</div>
							<div className='text-12 mt-4'>{channel.resolution}</div>
							<div className='text-11 mt-2 opacity-70'>{channel.fps} fps</div>
						</button>
					))}
				</div>
				
				{/* Channel Info Display */}
				{currentChannel && (
					<div className='bg-gray-50 p-12 rounded-8 text-sm'>
						<div className='flex justify-between mb-4'>
							<span className='opacity-60'>Resolution:</span>
							<span className='font-medium'>{currentChannel.resolution}</span>
						</div>
						<div className='flex justify-between mb-4'>
							<span className='opacity-60'>Frame Rate:</span>
							<span className='font-medium'>{currentChannel.fps} fps</span>
						</div>
						<div className='flex justify-between mb-4'>
							<span className='opacity-60'>Bitrate:</span>
							<span className='font-medium'>{currentChannel.bitrate}</span>
						</div>
						<div className='flex justify-between mb-4'>
							<span className='opacity-60'>Status:</span>
							<span className={`font-medium ${
								connectionState === 1 ? 'text-green-600' : 'text-gray-600'
							}`}>
								{connectionStateLabels[connectionState as keyof typeof connectionStateLabels]}
							</span>
						</div>
						<div className='mt-8 pt-8 border-t border-gray-200'>
							<div className='text-11 opacity-60'>Use Case:</div>
							<div className='text-12 mt-2'>{currentChannel.use_case}</div>
						</div>
					</div>
				)}
			</div>

			{/* Video Player */}
			<div className='iframe my-20  flex justify-center' style={{ height: 'auto' }}>
				<video
					className='rounded-20'
					id='player'
					width='100%'
					muted
					autoPlay
					playsInline
				></video>
			</div>
			
			{/* Timestamp and Delay Info */}
			<div className='flex justify-between text-black opacity-60 mb-10'>
				<span>Time Stamp</span>
				<span>Delay</span>
			</div>

			<div className='flex justify-between text-17 '>
				<span>{moment(timeObj.time||0).format('YYYY-MM-DD hh:mm:ss')}</span>
				<span>{timeObj.delay}ms</span>
			</div>
		</div>
	)
}

export default Home
